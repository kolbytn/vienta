import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import open from "open";
import "dotenv/config";
import { OAuth2Client } from "google-auth-library";
import session from "express-session";

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const porcupineKey = process.env.PORCUPINE_ACCESS_KEY;

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Google OAuth setup
const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

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

// Google OAuth routes
app.get('/auth/google', (req, res) => {
  // Store the intended destination URL in the session
  req.session.returnTo = req.query.returnTo || '/';
  
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/spreadsheets'
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    
    // Store tokens in session
    req.session.tokens = tokens;
    
    // Get user info
    oauth2Client.setCredentials(tokens);
    const userInfoClient = new OAuth2Client();
    userInfoClient.setCredentials(tokens);
    
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const userInfo = await userInfoResponse.json();
    
    // Store user info in session
    req.session.user = userInfo;
    
    // Redirect to the stored return URL or default to home
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    
    res.redirect(returnTo);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect('/?error=auth_failed');
  }
});

// Check authentication status
app.get('/auth/status', (req, res) => {
  const isAuthenticated = !!req.session.tokens;
  res.json({ 
    isAuthenticated,
    user: req.session.user || null
  });
});

// Logout route
app.post('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      res.status(500).json({ error: 'Failed to logout' });
    } else {
      res.json({ success: true });
    }
  });
});

// Middleware to refresh token if needed
app.use(async (req, res, next) => {
  if (req.session?.tokens) {
    const tokens = req.session.tokens;
    
    // Check if access token is expired or will expire soon
    const expiryDate = tokens.expiry_date;
    const isExpired = expiryDate ? Date.now() >= expiryDate : false;
    
    if (isExpired && tokens.refresh_token) {
      try {
        oauth2Client.setCredentials(tokens);
        const { credentials } = await oauth2Client.refreshAccessToken();
        req.session.tokens = credentials;
      } catch (error) {
        console.error('Token refresh error:', error);
        // Clear invalid session
        req.session.destroy();
      }
    }
  }
  next();
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
