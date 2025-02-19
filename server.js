import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import open from "open";
import "dotenv/config";

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const porcupineKey = process.env.PORCUPINE_ACCESS_KEY;

// Configure Vite middleware for React client
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "custom",
});
app.use(vite.middlewares);

// API route to check if server has an API key configured
app.get("/api-key-status", (req, res) => {
  res.json({ hasServerKey: !!apiKey });
});

// API route for OpenAI token generation
app.get("/token", async (req, res) => {
  // If client provides their own key, don't use server key
  const useKey = req.headers.authorization?.replace('Bearer ', '') || apiKey;
  
  if (!useKey) {
    return res.status(401).json({ 
      error: "No API key available. Please provide your own key or contact the administrator." 
    });
  }

  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${useKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "sol",
        }),
      },
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// API route for Porcupine initialization
app.post("/porcupine/init", async (req, res) => {
  try {
    // Return the access key directly for now
    // In a production environment, you might want to:
    // 1. Generate a temporary token
    // 2. Add rate limiting
    // 3. Add authentication
    // 4. Add request validation
    res.json({ accessKey: porcupineKey });
  } catch (error) {
    console.error("Porcupine initialization error:", error);
    res.status(500).json({ error: "Failed to initialize Porcupine" });
  }
});

// Render the React client
app.use("*", async (req, res, next) => {
  const url = req.originalUrl;

  try {
    const template = await vite.transformIndexHtml(
      url,
      fs.readFileSync("./client/index.html", "utf-8"),
    );
    const { render } = await vite.ssrLoadModule("./client/entry-server.jsx");
    const appHtml = await render(url);
    const html = template.replace(`<!--ssr-outlet-->`, appHtml?.html);
    res.status(200).set({ "Content-Type": "text/html" }).end(html);
  } catch (e) {
    vite.ssrFixStacktrace(e);
    next(e);
  }
});

app.listen(port, () => {
  console.log(`Express server running on *:${port}`);
});

open(`http://localhost:${port}`);
