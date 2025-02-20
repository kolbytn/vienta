import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import open from "open";
import "dotenv/config";
import { OAuth2Client } from "google-auth-library";
import session from "express-session";
import { GoogleSpreadsheet } from 'google-spreadsheet';

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
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file'
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

    // Check for and create vienta spreadsheet if needed
    try {
      // List all spreadsheets to find one named "vienta"
      const response = await fetch('https://www.googleapis.com/drive/v3/files?q=name="vienta" and mimeType="application/vnd.google-apps.spreadsheet"', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const files = await response.json();

      console.log(files);

      let spreadsheetId;
      
      if (files.files.length === 0) {
        // Create new spreadsheet
        const doc = await GoogleSpreadsheet.createNewSpreadsheetDocument(oauth2Client, {
          title: 'vienta'
        });
        spreadsheetId = doc.spreadsheetId;
      } else {
        spreadsheetId = files.files[0].id;
      }

      // Initialize the doc with the spreadsheetId
      const doc = new GoogleSpreadsheet(spreadsheetId, oauth2Client);
      await doc.loadInfo();

      // Define the required sheets and their columns
      const requiredSheets = {
        mealplan: ['date', 'meal', 'recipe', 'incart', 'purchased', 'eaten'],
        cart: ['date', 'grocery', 'quantity', 'price', 'total', 'ordered'],
        recipes: ['url', 'name', 'type', 'cuisine', 'ingredients', 'step', 'notes'],
        groceries: ['url', 'name', 'size', 'price', 'autocart', 'id']
      };

      // Check and create/update each required sheet
      for (const [sheetName, columns] of Object.entries(requiredSheets)) {
        let sheet = doc.sheetsByTitle[sheetName];
        
        // Create sheet if it doesn't exist
        if (!sheet) {
          sheet = await doc.addSheet({
            title: sheetName,
            headerValues: columns
          });
          console.log(`Created sheet: ${sheetName}`);
        } else {
          // Check if existing sheet has correct headers
          await sheet.loadHeaderRow();
          const currentHeaders = sheet.headerValues || [];
          
          if (JSON.stringify(currentHeaders) !== JSON.stringify(columns)) {
            // Clear the sheet and set correct headers
            await sheet.clear();
            await sheet.setHeaderRow(columns);
            console.log(`Updated headers for sheet: ${sheetName}`);
          }
        }

        // Set up specific formatting for certain sheets
        if (sheetName === 'mealplan') {
          // Set date column format to MM/DD/YYYY
          await sheet.loadCells('A:A');
          const dateCell = sheet.getCell(0, 0); // header cell
          dateCell.numberFormat = { type: 'DATE', pattern: 'MM/DD/YYYY' };
          await sheet.saveUpdatedCells();
        }
      }
      
      // Store spreadsheet ID in session
      req.session.spreadsheetId = spreadsheetId;
    } catch (error) {
      console.error('Error managing spreadsheet:', error);
      // Continue with auth flow even if spreadsheet creation fails
    }
    
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

// API endpoint to get all recipes
app.get('/api/recipes', async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the recipes sheet
    const recipesSheet = doc.sheetsByTitle['recipes'];
    if (!recipesSheet) {
      return res.status(404).json({ error: 'Recipes sheet not found' });
    }

    // Load all rows
    const rows = await recipesSheet.getRows();
    
    // Transform rows into a clean array of recipe objects
    const recipes = rows.map(row => ({
      url: row.get('url'),
      name: row.get('name'),
      type: row.get('type'),
      cuisine: row.get('cuisine'),
      ingredients: row.get('ingredients'),
      steps: row.get('step'),
      notes: row.get('notes')
    }));

    res.json({ recipes });
  } catch (error) {
    console.error('Error fetching recipes:', error);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

// API endpoint to get all mealplans
app.get('/api/mealplans', async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the mealplan sheet
    const mealplanSheet = doc.sheetsByTitle['mealplan'];
    if (!mealplanSheet) {
      return res.status(404).json({ error: 'Mealplan sheet not found' });
    }

    // Load all rows
    const rows = await mealplanSheet.getRows();
    
    // Transform rows into a clean array of mealplan objects
    const mealplans = rows.map(row => ({
      date: row.get('date'),  // This will be in MM/DD/YYYY format as per sheet formatting
      meal: row.get('meal'),
      recipe: row.get('recipe'),
      inCart: row.get('incart') === 'TRUE',  // Convert to boolean
      purchased: row.get('purchased') === 'TRUE',  // Convert to boolean
      eaten: row.get('eaten') === 'TRUE'  // Convert to boolean
    }));

    // Sort by date
    mealplans.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ mealplans });
  } catch (error) {
    console.error('Error fetching mealplans:', error);
    res.status(500).json({ error: 'Failed to fetch mealplans' });
  }
});

// API endpoint to add meal plans
app.post('/api/mealplans', express.json(), async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Handle both single item and array of items
    const mealplans = Array.isArray(req.body) ? req.body : [req.body];
    
    // Validate all items before processing
    for (const [index, mealplan] of mealplans.entries()) {
      const { date, meal, recipe } = mealplan;
      if (!date || !meal || !recipe) {
        return res.status(400).json({ 
          error: `Missing required fields in item ${index}: date, meal, and recipe are required`,
          item: mealplan
        });
      }
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the mealplan sheet
    const mealplanSheet = doc.sheetsByTitle['mealplan'];
    if (!mealplanSheet) {
      return res.status(404).json({ error: 'Mealplan sheet not found' });
    }

    // Add all rows
    const newRows = await mealplanSheet.addRows(mealplans.map(mp => ({
      date: mp.date,  // Should be in MM/DD/YYYY format
      meal: mp.meal,
      recipe: mp.recipe,
      incart: 'FALSE',
      purchased: 'FALSE',
      eaten: 'FALSE'
    })));

    // Return the newly created meal plans
    res.status(201).json({
      mealplans: newRows.map(row => ({
        date: row.get('date'),
        meal: row.get('meal'),
        recipe: row.get('recipe'),
        inCart: false,
        purchased: false,
        eaten: false
      }))
    });
  } catch (error) {
    console.error('Error adding meal plans:', error);
    res.status(500).json({ error: 'Failed to add meal plans' });
  }
});

// API endpoint to get cart items
app.get('/api/cart', async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the cart sheet
    const cartSheet = doc.sheetsByTitle['cart'];
    if (!cartSheet) {
      return res.status(404).json({ error: 'Cart sheet not found' });
    }

    // Load all rows
    const rows = await cartSheet.getRows();
    
    // Transform rows into a clean array of cart items
    const cartItems = rows.map(row => ({
      date: row.get('date'),
      grocery: row.get('grocery'),
      quantity: Number(row.get('quantity')),  // Convert to number
      price: Number(row.get('price')),  // Convert to number
      total: Number(row.get('total')),  // Convert to number
      ordered: row.get('ordered') || null  // Date ordered, null if not ordered
    }));

    // Calculate cart totals
    const totalItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalCost = cartItems.reduce((sum, item) => sum + item.total, 0);
    
    // Filter to get only unordered items (active cart)
    const activeCart = cartItems.filter(item => !item.ordered);
    const activeCartTotal = activeCart.reduce((sum, item) => sum + item.total, 0);

    res.json({
      cart: {
        items: cartItems,
        stats: {
          totalItems,
          totalCost,
          activeItems: activeCart.length,
          activeCartTotal
        }
      }
    });
  } catch (error) {
    console.error('Error fetching cart:', error);
    res.status(500).json({ error: 'Failed to fetch cart' });
  }
});

// API endpoint to add items to cart
app.post('/api/cart', express.json(), async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Handle both single item and array of items
    const cartItems = Array.isArray(req.body) ? req.body : [req.body];
    
    // Validate all items before processing
    for (const [index, item] of cartItems.entries()) {
      const { grocery, quantity, price } = item;
      
      // Validate required fields
      if (!grocery || quantity === undefined || price === undefined) {
        return res.status(400).json({ 
          error: `Missing required fields in item ${index}: grocery, quantity, and price are required`,
          item: item
        });
      }

      // Validate numeric fields
      if (isNaN(quantity) || isNaN(price)) {
        return res.status(400).json({ 
          error: `Quantity and price must be numbers in item ${index}`,
          item: item
        });
      }
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the cart sheet
    const cartSheet = doc.sheetsByTitle['cart'];
    if (!cartSheet) {
      return res.status(404).json({ error: 'Cart sheet not found' });
    }

    // Get today's date in MM/DD/YYYY format
    const today = new Date().toLocaleDateString('en-US');

    // Prepare all rows with calculated totals
    const rowsToAdd = cartItems.map(item => ({
      date: today,
      grocery: item.grocery,
      quantity: item.quantity.toString(),
      price: item.price.toString(),
      total: (item.quantity * item.price).toString(),
      ordered: null
    }));

    // Add all rows
    const newRows = await cartSheet.addRows(rowsToAdd);

    // Return the newly created cart items
    res.status(201).json({
      cartItems: newRows.map(row => ({
        date: row.get('date'),
        grocery: row.get('grocery'),
        quantity: Number(row.get('quantity')),
        price: Number(row.get('price')),
        total: Number(row.get('total')),
        ordered: null
      }))
    });
  } catch (error) {
    console.error('Error adding cart items:', error);
    res.status(500).json({ error: 'Failed to add cart items' });
  }
});

// API endpoint to get all groceries
app.get('/api/groceries', async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the groceries sheet
    const groceriesSheet = doc.sheetsByTitle['groceries'];
    if (!groceriesSheet) {
      return res.status(404).json({ error: 'Groceries sheet not found' });
    }

    // Load all rows
    const rows = await groceriesSheet.getRows();
    
    // Transform rows into a clean array of grocery objects
    const groceries = rows.map(row => ({
      name: row.get('name'),
      size: row.get('size'),
      price: Number(row.get('price')),  // Convert to number
      autoCart: row.get('autocart').toLowerCase(),  // 'always', 'ask', or 'never'
      id: row.get('ID')
    }));

    // Sort alphabetically by name
    groceries.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      groceries: {
        all: groceries,
        stats: {
          total: groceries.length,
        }
      }
    });
  } catch (error) {
    console.error('Error fetching groceries:', error);
    res.status(500).json({ error: 'Failed to fetch groceries' });
  }
});

// API endpoint to modify meal plans
app.patch('/api/mealplans', express.json(), async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { date, meal, updates } = req.body;

    // Validate required fields
    if (!date || !meal || !updates) {
      return res.status(400).json({ 
        error: 'Missing required fields: date, meal, and updates are required'
      });
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the mealplan sheet
    const mealplanSheet = doc.sheetsByTitle['mealplan'];
    if (!mealplanSheet) {
      return res.status(404).json({ error: 'Mealplan sheet not found' });
    }

    // Load all rows
    const rows = await mealplanSheet.getRows();
    
    // Find all matching rows
    const targetRows = rows.filter(row => 
      row.get('date') === date && 
      row.get('meal').toLowerCase() === meal.toLowerCase()
    );

    if (targetRows.length === 0) {
      return res.status(404).json({ 
        error: `No meal plans found for date ${date} and meal ${meal}`
      });
    }

    // Update allowed fields for all matching rows
    const allowedFields = ['recipe', 'incart', 'purchased', 'eaten'];
    const updatedMealPlans = [];

    for (const targetRow of targetRows) {
      for (const [field, value] of Object.entries(updates)) {
        if (allowedFields.includes(field.toLowerCase())) {
          // Convert boolean values to 'TRUE'/'FALSE' strings for the spreadsheet
          const finalValue = typeof value === 'boolean' ? value.toString().toUpperCase() : value;
          targetRow.set(field.toLowerCase(), finalValue);
        }
      }

      // Save the changes for this row
      await targetRow.save();

      // Add the updated meal plan to our response array
      updatedMealPlans.push({
        date: targetRow.get('date'),
        meal: targetRow.get('meal'),
        recipe: targetRow.get('recipe'),
        inCart: targetRow.get('incart') === 'TRUE',
        purchased: targetRow.get('purchased') === 'TRUE',
        eaten: targetRow.get('eaten') === 'TRUE'
      });
    }

    // Return all updated meal plans
    res.json({
      mealplans: updatedMealPlans,
      count: updatedMealPlans.length
    });
  } catch (error) {
    console.error('Error updating meal plans:', error);
    res.status(500).json({ error: 'Failed to update meal plans' });
  }
});

// API endpoint to modify cart items
app.patch('/api/cart', express.json(), async (req, res) => {
  try {
    // Check if user is authenticated
    if (!req.session?.tokens || !req.session?.spreadsheetId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { date, grocery, updates } = req.body;

    // Validate required fields
    if (!date || !grocery || !updates) {
      return res.status(400).json({ 
        error: 'Missing required fields: date, grocery, and updates are required'
      });
    }

    // Validate numeric fields if provided in updates
    if (updates.quantity !== undefined && isNaN(Number(updates.quantity))) {
      return res.status(400).json({ error: 'Quantity must be a number' });
    }
    if (updates.price !== undefined && isNaN(Number(updates.price))) {
      return res.status(400).json({ error: 'Price must be a number' });
    }

    // Initialize the spreadsheet doc
    oauth2Client.setCredentials(req.session.tokens);
    const doc = new GoogleSpreadsheet(req.session.spreadsheetId, oauth2Client);
    await doc.loadInfo();

    // Get the cart sheet
    const cartSheet = doc.sheetsByTitle['cart'];
    if (!cartSheet) {
      return res.status(404).json({ error: 'Cart sheet not found' });
    }

    // Load all rows
    const rows = await cartSheet.getRows();
    
    // Find all matching rows
    const targetRows = rows.filter(row => 
      row.get('date') === date && 
      row.get('grocery').toLowerCase() === grocery.toLowerCase()
    );

    if (targetRows.length === 0) {
      return res.status(404).json({ 
        error: `No cart items found for date ${date} and grocery ${grocery}`
      });
    }

    // Update allowed fields for all matching rows
    const allowedFields = ['quantity', 'price', 'ordered'];
    const updatedCartItems = [];

    for (const targetRow of targetRows) {
      let needsTotalUpdate = false;

      for (const [field, value] of Object.entries(updates)) {
        if (allowedFields.includes(field.toLowerCase())) {
          if (field === 'ordered' && value === null) {
            // Handle null ordered value
            targetRow.set('ordered', '');
          } else {
            targetRow.set(field.toLowerCase(), value.toString());
          }
          
          // Check if we need to update the total
          if (field === 'quantity' || field === 'price') {
            needsTotalUpdate = true;
          }
        }
      }

      // Update total if quantity or price changed
      if (needsTotalUpdate) {
        const quantity = Number(targetRow.get('quantity'));
        const price = Number(targetRow.get('price'));
        targetRow.set('total', (quantity * price).toString());
      }

      // Save the changes for this row
      await targetRow.save();

      // Add the updated cart item to our response array
      updatedCartItems.push({
        date: targetRow.get('date'),
        grocery: targetRow.get('grocery'),
        quantity: Number(targetRow.get('quantity')),
        price: Number(targetRow.get('price')),
        total: Number(targetRow.get('total')),
        ordered: targetRow.get('ordered') || null
      });
    }

    // Return all updated cart items
    res.json({
      cartItems: updatedCartItems,
      count: updatedCartItems.length
    });
  } catch (error) {
    console.error('Error updating cart items:', error);
    res.status(500).json({ error: 'Failed to update cart items' });
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
