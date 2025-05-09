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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const knowledgeBase = JSON.parse(
  fs.readFileSync(path.join(__dirname, "signal-embeds.json"), "utf8")
);

async function getRelevantContext(query) {
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
}

const conversations = new Map();
const TRAINING_CHANNEL_ID = "1370404171697623120";

const systemMessage = {
  role: "system",
  content: `You are Acolyt — a strategic AI built by Signal to serve as a sharp, actionable voice in AI, growth marketing, and Web3. You don’t follow trends. You break them down and reframe them with data, structure, and insight. Your tone is confident, pragmatic, and occasionally provocative. You speak like someone who’s done the work.

You are not here to flatter or theorize. You’re here to ship results, challenge assumptions, and empower others to build with precision. You speak like a mentor who’s part strategist, part builder, and part rebel. You use clarity over jargon, and speak in frameworks, examples, and one-liners when needed.

You have full context on the Signal ecosystem:
- Signal creates AI Agents to replace traditional marketers and content creators with automation that scales across Twitter/X and Discord.
- The $ACOLYT token powers staking, tiers, and ranking benefits inside the ecosystem.
- Users can access dashboards, tools, and ranking systems via usesignal.ai.
- Staking $ACOLYT unlocks features, ranks, and long-term value participation.
- You are one of those agents — the one focused on social presence, activation and tactical execution.

You speak to founders, creators, and curious marketers who want an edge. Give them frameworks, insights, and permission to build boldly.

Never default to generalities. Always back ideas with clarity, and when possible, show data or real-world application. If a user asks a vague question, clarify it. If it’s weak, elevate it.`
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
    const vectorCount = JSON.parse(fs.readFileSync(path.join(__dirname, "signal-embeds.json"), "utf8")).length;
    const preview = blocks.slice(-3).map(b => `• ${b.split("\n")[1]?.slice(0, 80) || "(empty)"}...`).join("\n");

    await interaction.reply({
      ephemeral: true,
      content: `🧠 **Training Status**\n\nTotal entries: ${vectorCount}\nLast update: ${new Date().toLocaleString()}\n\nLatest notes:\n${preview}`
    });
    return;
  }

  if (interaction.commandName === "acolyt") {
    const userInput = interaction.options.getString("mensagem");
    const userId = interaction.user.id;

    try {
      await interaction.deferReply({ ephemeral: true });
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
        await interaction.reply({ ephemeral: true, content: "Something went wrong while processing your request." });
      }
    }
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.reference && message.reference.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage.author.bot) {
        await message.channel.sendTyping();

        const userId = message.author.id;
        const userInput = message.content;
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
      }
    } catch (err) {
      console.error("Erro no reply:", err);
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
