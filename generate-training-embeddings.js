const fs = require("fs");
const path = require("path");
const { OpenAI } = require("openai");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  const trainingPath = path.join(__dirname, "knowledge", "training-notes.md");
  const outputPath = path.join(__dirname, "signal-embeds.json");

  // Lê o conteúdo do arquivo de treinamento
  const content = fs.readFileSync(trainingPath, "utf8");
  const chunks = content.split(/\n{2,}/).map(c => c.trim()).filter(Boolean);

  const vectors = [];

  for (const chunk of chunks) {
    console.log("Embedding chunk:", chunk.slice(0, 60) + "...");
    const res = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk,
    });

    vectors.push({
      content: chunk,
      embedding: res.data[0].embedding,
    });
  }

  fs.writeFileSync(outputPath, JSON.stringify(vectors, null, 2));
  console.log("✅ signal-embeds.json atualizado com sucesso!");
}

main().catch(console.error);
