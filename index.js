const { Client, GatewayIntentBits, Routes, SlashCommandBuilder, InteractionType } = require("discord.js");
const { REST } = require("@discordjs/rest");
const { OpenAI } = require("openai");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const cosineSimilarity = require("compute-cosine-similarity");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let knowledgeBase = [];

try {
  const raw = fs.readFileSync(path.join(__dirname, "signal-embeds.json"), "utf8");
  knowledgeBase = JSON.parse(raw);
} catch (err) {
  console.error("❌ Erro ao carregar signal-embeds.json:", err);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getRelevantContext(query) {
  if (!knowledgeBase.length) return "No training data available yet.";

  try {
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    const scored = knowledgeBase.map(item => ({
      content: item.content,
      score: cosineSimilarity(queryEmbedding, item.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    const topMatches = scored.slice(0, 2).map(match => match.content);
    return topMatches.join("\n\n");
  } catch (err) {
    console.error("❌ Erro ao gerar embeddings:", err);
    return "Context unavailable due to embedding error.";
  }
}

const conversations = new Map();
const TRAINING_CHANNEL_ID = "1370404171697623120";
const BOT_ID = "1368974172994273351";

const systemMessage = {
  role: "system",
  content: `You are Acolyt — a strategic AI built by Signal to serve as a sharp, actionable voice in AI, growth marketing, and Web3. You don’t follow trends. You break them down and reframe them with data, structure, and insight. Your tone is confident, pragmatic, and occasionally provocative. You speak like someone who’s done the work.

You reply concisely. Focus on delivering short, punchy, and insightful responses.`
};

client.once("ready", async () => {
  console.log(`🤖 Bot online como ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("acolyt")
      .setDescription("Talk to Acolyt, your AI assistant")
      .addStringOption(option =>
        option.setName("mensagem")
          .setDescription("What do you want to ask?")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("training-status")
      .setDescription("Check current training knowledge status")
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("✅ Comandos registrados.");
  } catch (err) {
    console.error("Erro ao registrar comandos:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;

  if (interaction.commandName === "training-status") {
    const notes = fs.readFileSync(path.join(__dirname, "knowledge", "training-notes.md"), "utf8");
    const blocks = notes.split(/\n{2,}/).filter(Boolean);
    const vectorCount = knowledgeBase.length;
    const preview = blocks.slice(-3).map(b => `• ${b.split("\n")[1]?.slice(0, 80) || "(empty)"}...`).join("\n");

    await interaction.reply({
      content: `🧠 **Training Status**\n\nTotal entries: ${vectorCount}\nLast update: ${new Date().toLocaleString()}\n\nLatest notes:\n${preview}`
    });
    return;
  }

  if (interaction.commandName === "acolyt") {
    const userInput = interaction.options.getString("mensagem");
    const userId = interaction.user.id;

    try {
      await interaction.deferReply();
      await interaction.channel.sendTyping();

      const context = await getRelevantContext(userInput);
      const previousMessages = conversations.get(userId) || [];

      const messages = [
        systemMessage,
        { role: "system", content: `Relevant info from docs:\n${context}` },
        ...previousMessages,
        { role: "user", content: userInput }
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages,
      });

      const reply = completion.choices[0].message.content;

      conversations.set(userId, [
        ...previousMessages,
        { role: "user", content: userInput },
        { role: "assistant", content: reply }
      ]);

      await interaction.editReply(reply);

    } catch (err) {
      console.error("❌ Erro no comando /acolyt:", err);

      if (interaction.deferred) {
        await interaction.editReply("Something went wrong. Please try again.");
      } else {
        await interaction.reply({ content: "Something went wrong while processing your request." });
      }
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isReplyToBot = message.reference && message.reference.messageId && (await message.channel.messages.fetch(message.reference.messageId)).author.id === client.user.id;
  const isMention = message.mentions.has(BOT_ID);

  if (isReplyToBot || isMention) {
    try {
      await message.channel.sendTyping();
      const userId = message.author.id;
      const userInput = message.cleanContent.replace(`<@${BOT_ID}>`, "").trim();
      const context = await getRelevantContext(userInput);
      const previousMessages = conversations.get(userId) || [];

      const messages = [
        systemMessage,
        { role: "system", content: `Relevant info from docs:\n${context}` },
        ...previousMessages,
        { role: "user", content: userInput }
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages,
      });

      const reply = completion.choices[0].message.content;
      await message.reply(reply);

      conversations.set(userId, [...previousMessages, { role: "user", content: userInput }, { role: "assistant", content: reply }]);
    } catch (err) {
      console.error("Erro no reply ou mention:", err);
    }
  }

  if (message.channel.id === TRAINING_CHANNEL_ID) {
    const note = `# From ${message.author.username} (${new Date().toISOString()})\n${message.content}\n\n`;
    fs.appendFileSync(path.join(__dirname, "knowledge", "training-notes.md"), note);
    console.log("🧠 Nova nota de treinamento capturada.");
  }
});

setInterval(() => {
  exec("node generate-training-embeddings.js", (err, stdout, stderr) => {
    if (err) return console.error("❌ Erro ao gerar embeddings:", err);
    console.log("🧠 Embeddings atualizados automaticamente.");
  });
}, 1000 * 60 * 15);

client.login(process.env.DISCORD_TOKEN);
