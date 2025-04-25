// Load environment variables from .env file at the very start
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { Pool } = require('pg'); // Require the Pool class from 'pg'
const pgSession = require('connect-pg-simple')(session); // Pass 'session' to connect-pg-simple
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const vision = require('@google-cloud/vision');
const { format, toZonedTime } = require('date-fns-tz');
// Optional: If using MongoDB for session storage
// const MongoStore = require('connect-mongo');

const app = express();

// --- TRUST PROXY ---
// Required for secure cookies to work behind Render's load balancer/proxy
app.set('trust proxy', 1); // Trust the first proxy hop (Render's LB)
console.log("Configured Express to trust proxy.");
// -----------------

// --- Configuration from Environment Variables ---
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Sheet1';
const APP_FOLDER_NAME = process.env.GOOGLE_DRIVE_APP_FOLDER_NAME || 'ReceiptManagerUploads';
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = process.env.PORT || 3000;
const TIME_ZONE = 'Asia/Kuala_Lumpur'
const PAYMENT_METHODS_STRING = process.env.PAYMENT_METHODS || 'Cash,Bank Transfer'; // Default if not set

// --- Process Payment Methods ---
// Split the string into an array, trim whitespace from each item
const paymentMethodOptions = PAYMENT_METHODS_STRING.split(',')
    .map(method => method.trim())
    .filter(method => method.length > 0); // Remove empty strings if trailing/double commas exist

// ... config loading ...
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_LOCAL_DEV_DB = process.env.NODE_ENV === 'development_db';

const CURRENT_NODE_ENV = process.env.NODE_ENV; // Get env variable once
console.log(`Current NODE_ENV = ${CURRENT_NODE_ENV}`); // Log the actual value

// --- Conditionally configure Pool and Store ---
let sessionStore; // Define store variable

// --- Declare pool variable in the main module scope ---
let pool; // Use 'let' so it can be assigned later

if (IS_PRODUCTION || IS_LOCAL_DEV_DB) {
    console.log(`${IS_PRODUCTION ? 'Production environment detected' : 'Development environment detected'}.`);
    console.log("Configuring PostgreSQL session store.");

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.error(`FATAL ERROR: DATABASE_URL environment variable not set! Current NODE_ENV=${process.env.NODE_ENV}`);
        process.exit(1); // Exit if DB URL missing in production
    }
    
    // --- Define Pool Options ---
    const poolOptions = {
        connectionString: databaseUrl,
        // Start with SSL undefined
        ssl: undefined
    };

    // --- Explicitly Add SSL ONLY for Production ---
    if (CURRENT_NODE_ENV === 'production') {
        console.log("NODE_ENV is 'production'. Enabling SSL for PostgreSQL.");
        poolOptions.ssl = {
            rejectUnauthorized: false // Required for Render database connections
        };
    } else {
        console.log(`NODE_ENV is '${CURRENT_NODE_ENV}'. SSL for PostgreSQL is DISABLED.`);
        // Explicitly ensure SSL is not set or is false if needed,
        // but undefined is usually sufficient for pg client to default to non-SSL.
        // poolOptions.ssl = false; // Generally not needed
    }
    // --- End Conditional SSL ---

    try {
        pool = new Pool(poolOptions); // Pass the constructed options object
        pool.on('error', (err, client) => { console.error('!!! PostgreSQL Pool Error:', err); });
        console.log(`PostgreSQL Pool configured successfully.`);
    } catch (poolError) {
        console.error("FATAL ERROR: Failed to initialize PostgreSQL Pool!");
        console.error(poolError);
        process.exit(1);
    }

    // --- Session Configuration (Use the pool variable) ---
    // Ensure pool exists before configuring store
    if (!pool) {
        console.error("FATAL ERROR: Pool was not initialized before setting up session store.");
        process.exit(1);
    }
    const sessionStore = new pgSession({
        pool: pool, // Use the initialized pool
        tableName: 'user_sessions',
        createTableIfMissing: true
    });

    console.log(`PostgreSQL Pool and Session Store configured for  current NODE_ENV=${process.env.NODE_ENV}`);
    
} else {
    console.log("Development environment detected. Using MemoryStore for sessions.");
    // MemoryStore is the default, so we don't explicitly set store = new session.MemoryStore()
    // But clear log indicates what's happening.
    sessionStore = undefined; // Use default MemoryStore
    // Print the warning only in development
    console.warn("Warning: Using MemoryStore for sessions. Data will be lost on server restart.");
}

// --- Essential Variable Checks ---
if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    console.error('FATAL ERROR: Google OAuth credentials (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI) not configured in .env file.');
    process.exit(1);
}
if (!SPREADSHEET_ID) {
    console.warn('WARNING: GOOGLE_SPREADSHEET_ID not configured in .env file. Sheet operations will likely fail.');
}
if (!SESSION_SECRET || SESSION_SECRET === 'PASTE_YOUR_GENERATED_SESSION_SECRET_HERE' || SESSION_SECRET.length < 32) {
     console.warn('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
     console.warn('WARNING: SESSION_SECRET is missing, insecure, or too short!');
     console.warn('Please set a strong, random SESSION_SECRET in your .env file.');
     console.warn('Generate one using: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
     console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
}

// --- Session Configuration (Uses the conditionally defined store) ---
// --- Session Configuration ---
app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: CURRENT_NODE_ENV === 'production', // Use the flag consistently
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 30
    }
}));
console.log(`Express session configured using PostgreSQL store (NODE_ENV=${CURRENT_NODE_ENV}).`);

// --- Google Clients ---
console.log(`--- Initializing OAuth2 Client ---`); // Add log
console.log(`Using CLIENT_ID: ${CLIENT_ID ? 'Set' : 'MISSING!'}`); // Add log
console.log(`Using CLIENT_SECRET: ${CLIENT_SECRET ? 'Set' : 'MISSING!'}`); // Add log
console.log(`Using REDIRECT_URI: ${REDIRECT_URI}`); // *** Add this critical log ***

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const visionClient = new vision.ImageAnnotatorClient(); // Uses ADC implicitly
const googleOAuth2 = google.oauth2('v2');
console.log(`--- OAuth2 Client Initialized ---`); 

// --- Multer Setup ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Middleware ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Routes ---

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route to initiate Google Login
app.get('/auth/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/cloud-vision',
        'https://www.googleapis.com/auth/spreadsheets',
        'profile', 'email'
    ];
    const authorizeUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'select_account' });
    console.log("Redirecting to Google for authentication (with account selection)...");
    res.redirect(authorizeUrl);
});

// Route Google redirects to after user consent
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    console.log("Callback: Received callback from Google.");
    if (!code) { return res.status(400).send('Authorization code missing.'); }

    let userRecord = null; // To store the user record from our DB

    try {
        console.log("Callback: Exchanging code for tokens...");
        const { tokens } = await oauth2Client.getToken(code);
        console.log("Callback: Tokens received.");
        oauth2Client.setCredentials(tokens); // Set credentials for userinfo call

        // --- Fetch User Info from Google ---
        console.log("Callback: Fetching Google user info...");
        const userInfoResponse = await googleOAuth2.userinfo.get({ auth: oauth2Client });
        const googleUserInfo = userInfoResponse.data;

        if (!googleUserInfo || !googleUserInfo.id || !googleUserInfo.email) {
            throw new Error("Failed to retrieve valid user info from Google.");
        }
        console.log("Callback: Google User Info:", googleUserInfo.email);

        // --- Find or Create User in 'users' table ---
        const findUserQuery = 'SELECT * FROM users WHERE google_id = $1';
        const findUserResult = await pool.query(findUserQuery, [googleUserInfo.id]);

        if (findUserResult.rows.length > 0) {
            // User Found - Update existing record
            console.log(`Callback: User found in DB (ID: ${findUserResult.rows[0].user_id}). Updating...`);
            userRecord = findUserResult.rows[0];
            const updateUserQuery = `
                UPDATE users
                SET name = $1, picture_url = $2, last_login_at = NOW()
                WHERE user_id = $3
                RETURNING *;`; // Return updated record
            const updateUserResult = await pool.query(updateUserQuery, [
                googleUserInfo.name || 'N/A', // Use name from Google or default
                googleUserInfo.picture,
                userRecord.user_id
            ]);
            userRecord = updateUserResult.rows[0]; // Update local record variable
             console.log(`Callback: User record updated for ${userRecord.email}.`);
        } else {
            // User Not Found - Create new record
            console.log("Callback: User not found in DB. Creating new user...");
            const insertUserQuery = `
                INSERT INTO users (google_id, email, name, picture_url, last_login_at)
                VALUES ($1, $2, $3, $4, NOW())
                RETURNING *;`; // Return the newly created record
            const insertUserResult = await pool.query(insertUserQuery, [
                googleUserInfo.id,
                googleUserInfo.email,
                googleUserInfo.name || 'N/A',
                googleUserInfo.picture
            ]);
            userRecord = insertUserResult.rows[0];
            console.log(`Callback: New user created with ID: ${userRecord.user_id}, Email: ${userRecord.email}.`);
        }

        // --- Session Setup ---
        console.log("Callback: Setting session data...");
        req.session.accessToken = tokens.access_token;
        req.session.expiryDate = tokens.expiry_date;
        if (tokens.refresh_token) { req.session.refreshToken = tokens.refresh_token; }
        req.session.isLoggedIn = true;
        // Store internal user ID and maybe basic display info
        req.session.userId = userRecord.user_id;
        // Optional: Store basic info directly for immediate display, but /api/check-auth should be source of truth
        // req.session.userDisplay = { name: userRecord.name, picture: userRecord.picture_url };
        console.log(`Callback: Session data set. User ID: ${req.session.userId}, Session ID: ${req.sessionID}`);

        // --- Link Session ID in users table ---
        // Note: req.session.save() happens implicitly before redirect usually,
        // ensuring sessionID is available. We update the users table *after* session is set.
        const updateSessionLinkQuery = `
            UPDATE users
            SET current_session_id = $1
            WHERE user_id = $2;`;
        await pool.query(updateSessionLinkQuery, [req.sessionID, userRecord.user_id]);
        console.log(`Callback: Linked session ID ${req.sessionID} to user ID ${userRecord.user_id} in users table.`);

        // --- Redirect ---
        // Explicit save isn't strictly necessary with persistent stores usually,
        // but can help ensure things happen in order if needed. Redirect implies save.
        console.log("Callback: Redirecting to /");
        res.redirect('/');

    } catch (error) {
        console.error('Error during OAuth callback/User FindOrCreate:', error);
        // Clear potentially partially set session data on error?
        req.session.destroy(() => {
            res.status(500).send('Failed to authenticate or process user information.');
        });
    }
});

// Route for frontend to check if user is logged in
app.get('/api/check-auth', async (req, res) => { // Make async
    console.log("--- /api/check-auth ---");
    console.log("Session ID:", req.sessionID);
    console.log("Session Keys:", req.session ? Object.keys(req.session) : 'N/A');
    console.log("Session isLoggedIn:", req.session?.isLoggedIn);
    console.log("Session userId:", req.session?.userId);

    // Check for basic session validity and internal userId
    if (req.session?.isLoggedIn && req.session?.userId) {
        try {
            // Fetch current user details from DB using the stored userId
            const getUserQuery = 'SELECT user_id, email, name, picture_url FROM users WHERE user_id = $1';
            const userResult = await pool.query(getUserQuery, [req.session.userId]);

            if (userResult.rows.length > 0) {
                const userFromDb = userResult.rows[0];
                console.log("Check-auth: Found user in DB, sending details.");
                // Send details fetched from *your* database
                res.json({
                    loggedIn: true,
                    user: { // Map DB fields to expected frontend fields if needed
                        id: userFromDb.user_id, // Use your internal ID or keep consistent
                        email: userFromDb.email,
                        name: userFromDb.name,
                        picture: userFromDb.picture_url
                    }
                });
            } else {
                // User existed in session but not in DB? Session corruption? Log out.
                console.error(`Check-auth: User ID ${req.session.userId} found in session but not in DB! Destroying session.`);
                 req.session.destroy(() => {
                     res.clearCookie('connect.sid');
                     res.status(401).json({ loggedIn: false, user: null, message: "Session invalid." });
                 });
            }
        } catch (dbError) {
            console.error("Check-auth: Database error fetching user:", dbError);
            res.status(500).json({ loggedIn: false, user: null, message: "Error fetching user data." });
        }
    } else {
        // Not logged in according to session
        console.log("Check-auth: No valid session found.");
        res.json({ loggedIn: false, user: null });
    }
});

// Route for user logout
app.post('/api/logout', async (req, res) => {
    console.log("Logout: Request received.");
    // Get data needed BEFORE destroying the session
    const userId = req.session.userId;
    const sessionId = req.sessionID;
    const refreshToken = req.session.refreshToken;

    console.log(`Logout: User ID: ${userId}, Session ID: ${sessionId}`);

    try {
        // 1. Clear Session Link in 'users' table (if user ID is known)
        if (userId && sessionId) {
            try {
                 console.log(`Logout: Clearing current_session_id for user ${userId}`);
                 const updateQuery = `UPDATE users SET current_session_id = NULL WHERE user_id = $1 AND current_session_id = $2`;
                 const updateResult = await pool.query(updateQuery, [userId, sessionId]);
                 console.log(`Logout: Rows updated in users table: ${updateResult.rowCount}`);
            } catch (dbError) {
                 console.error("Logout: Error clearing session ID in users table:", dbError);
                 // Continue with logout even if this fails? Or report error? Let's continue for now.
            }
        } else {
             console.warn("Logout: Cannot clear session link in DB - userId or sessionId missing from session.");
        }

        // 2. Destroy Server-Side Session (removes row from user_sessions/session table)
        req.session.destroy(async (err) => {
            if (err) {
                console.error("Logout: Error destroying session:", err);
                // Still try to clear cookie and revoke token? Maybe send error earlier.
                 return res.status(500).json({ message: "Logout failed (session destroy error)." });
            }
            console.log("Logout: Session destroyed successfully.");

            // 3. Clear Client-Side Session Cookie
            res.clearCookie('connect.sid');

            // 4. Revoke Google Refresh Token
            if (refreshToken) {
                try {
                    console.log("Logout: Attempting to revoke refresh token...");
                    const revokeClient = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
                    await revokeClient.revokeToken(refreshToken);
                    console.log("Logout: Refresh token revoked successfully.");
                } catch (revokeError) {
                    console.error("Logout: Error revoking refresh token:", revokeError.message);
                }
            } else { console.log("Logout: No refresh token found in session to revoke."); }

            // 5. Send Success Response
            console.log("Logout: Process complete.");
            res.status(200).json({ message: "Logged out successfully." });
        });

    } catch (outerError) {
         // Catch errors from DB update before session destroy, though unlikely
         console.error("Logout: Unexpected error before session destroy:", outerError);
         res.status(500).json({ message: "Logout failed (unexpected error)." });
    }
});

// --- API Endpoint to Get Payment Methods ---
app.get('/api/payment-methods', (req, res) => {
    // Simple check if user is logged in - maybe not strictly necessary
    // but good practice if the list could be considered sensitive
    if (!req.session || !req.session.isLoggedIn) {
        return res.status(401).json({ message: 'User not authenticated.' });
    }
    res.json({ methods: paymentMethodOptions }); // Send the processed array
});

// --- Helper: Function to ensure valid access token ---
async function ensureValidToken(req) {
    if (!req.session.isLoggedIn || !req.session.accessToken || !req.session.expiryDate) {
        console.warn("ensureValidToken: No valid session/token found.");
        throw new Error("User not authenticated. Please log in again.");
    }
    const buffer = 5 * 60 * 1000; // 5 minutes buffer
    if (Date.now() >= req.session.expiryDate - buffer) {
        console.log("Access token expired or nearing expiry. Refreshing...");
        if (!req.session.refreshToken) {
            console.error("ensureValidToken: Refresh token missing from session!");
            req.session.destroy();
            throw new Error("Session expired and refresh token not found. Please log in again.");
        }
        try {
            oauth2Client.setCredentials({ refresh_token: req.session.refreshToken });
            const { credentials } = await oauth2Client.refreshAccessToken();
            console.log("Access token refreshed successfully.");
            req.session.accessToken = credentials.access_token;
            req.session.expiryDate = credentials.expiry_date;
            oauth2Client.setCredentials({ access_token: req.session.accessToken });
            return oauth2Client;
        } catch (refreshError) {
            console.error("Error refreshing access token:", refreshError.response ? JSON.stringify(refreshError.response.data) : refreshError.message);
            req.session.destroy();
            throw new Error("Failed to refresh authentication. Please log in again.");
        }
    } else {
         oauth2Client.setCredentials({ access_token: req.session.accessToken });
         return oauth2Client;
    }
}

// --- Modified Upload Endpoint ---
app.post('/upload', upload.single('receiptImage'), async (req, res) => {
    if (!req.session.isLoggedIn) {
        console.warn("Upload attempt by unauthenticated user.");
        return res.status(401).json({ message: 'User not authenticated.' });
    }
    console.log("Received upload request from authenticated user session.");

    // Get data from request
    const category = req.body.category;
    const userAmount = req.body.amount; // Get amount from form data
    const paymentMethod = req.body.paymentMethod;
    const file = req.file;

    // --- Generate Timestamps and Filename (UTC+8 / Asia/Kuala_Lumpur) ---
    const now = new Date(); // Current time in UTC
    const zonedDate = toZonedTime(now, TIME_ZONE);

    const uploadTimestamp = new Date().toISOString();

    // Backend Validation
    if (!file) { return res.status(400).json({ message: 'No file uploaded.' }); }
    if (!category) { return res.status(400).json({ message: 'Category is required.' }); }
    if (!userAmount || isNaN(parseFloat(userAmount)) || parseFloat(userAmount) <= 0) { // Added positive check
        console.warn("Invalid amount received from client:", userAmount);
        return res.status(400).json({ message: 'Valid positive amount is required.' });
    }
    if (!paymentMethod || !paymentMethodOptions.includes(paymentMethod)) { // Check if submitted method is in our allowed list
        console.warn(`Invalid payment method submitted: ${paymentMethod}`);
        // Optionally send back the allowed methods for debugging client-side issues
        return res.status(400).json({ message: 'Invalid payment method selected.'/*, allowed: paymentMethodOptions */});
   }

    const finalAmount = parseFloat(userAmount).toFixed(2); // Use validated & formatted amount

    // Format for Google Sheet (Human readable UTC+8)
    const uploadTimestampSheet = format(zonedDate, 'yyyy-MM-dd HH:mm:ss', { timeZone: TIME_ZONE });
    // Format for Filename (yyyymmddhhmmss UTC+8)
    const filenameTimestamp = format(zonedDate, 'yyyyMMddHHmmss', { timeZone: TIME_ZONE });

    // Determine file extension
    let fileExtension = path.extname(file.originalname).toLowerCase();
    if (!fileExtension) { // Fallback using mimetype if original name has no extension
        const mimeType = file.mimetype.split('/')[1];
        fileExtension = mimeType ? `.${mimeType.replace('jpeg', 'jpg')}` : '.jpg'; // Default to jpg
    }
    const newFilename = `${filenameTimestamp}${fileExtension}`;
    console.log(`Processing: Sheet Timestamp: ${uploadTimestampSheet}, Cat=${category}, Amt=${finalAmount}, Method=${paymentMethod}, File=${newFilename}`);
    // --- End Timestamp/Filename Generation ---

    try {
        const authenticatedClient = await ensureValidToken(req);

        let extractedData = { receiptDate: 'OCR Failed', totalAmount: 'OCR Skipped' }; // Default OCR status
        let driveFileId = null;
        let sheetMessage = '';

        // 1. Perform OCR (Optional: Primarily for date extraction)
        // try {
        //     console.log("Performing OCR (primarily for date)...");
        //     const request = { image: { content: file.buffer.toString('base64') } };
        //     const [ocrResult] = await visionClient.documentTextDetection(request);
        //     if (ocrResult.fullTextAnnotation && ocrResult.fullTextAnnotation.text) {
        //         const ocrDate = extractReceiptData(ocrResult.fullTextAnnotation.text).receiptDate;
        //         extractedData.receiptDate = ocrDate; // Store OCR date
        //         console.log("OCR extracted date:", ocrDate);
        //     } else {
                extractedData.receiptDate = 'No Text Found';
                console.log("OCR: OCR Skipped.");
                // console.log("OCR: No text found.");
        //     }
        // } catch (ocrError) {
        //     console.error('Error during Google Vision OCR:', ocrError.message || ocrError);
        //     extractedData.receiptDate = 'OCR Error';
        // }

        // 2. Google Drive Upload (Uses authenticatedClient and NEW FILENAME)
        try {
            console.log(`Uploading to Google Drive as ${newFilename}...`);
            const drive = google.drive({ version: 'v3', auth: authenticatedClient });
            const mainFolderId = await findOrCreateFolder(drive, APP_FOLDER_NAME, 'root');
            if (!mainFolderId) throw new Error(`Could not find/create main folder: ${APP_FOLDER_NAME}`);
            const categoryFolderId = await findOrCreateFolder(drive, category, mainFolderId);
            if (!categoryFolderId) throw new Error(`Could not find/create category folder: ${category}`);

            const bufferStream = new stream.PassThrough(); bufferStream.end(file.buffer);
            // *** Use newFilename in metadata ***
            const fileMetadata = { name: newFilename, parents: [categoryFolderId] };
            const media = { mimeType: file.mimetype, body: bufferStream };
            const driveResponse = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });
            driveFileId = driveResponse.data.id;
            console.log("Google Drive Upload successful. File ID:", driveFileId);
        } catch (driveError) { /* ... handle drive error ... */ throw driveError; }

        // 3. Append Data to Google Sheet (Uses authenticatedClient and USER AMOUNT)
        if (driveFileId && SPREADSHEET_ID) {
            try {
            console.log(`Appending to Google Sheet...`);
            const sheets = google.sheets({ version: 'v4', auth: authenticatedClient });
                // *** Update rowData array structure to include newFilename ***
                // Ensure order matches your Sheet columns (Example: F is File Name)
                const rowData = [
                    uploadTimestampSheet,     // A: Upload Timestamp (UTC+8)
                    extractedData.receiptDate, // B: Receipt Date (OCR)
                    finalAmount,             // C: Amount (User Input)
                    category,                // D: Category
                    paymentMethod,           // E: Payment Method (NEW) - Adjust position if needed
                    newFilename,             // F: File Name
                    driveFileId              // G: Drive File ID
                ];
                const appendRequest = {
                    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1`, // Append after last data in sheet
                    valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
                    resource: { values: [rowData] }
                };
                await sheets.spreadsheets.values.append(appendRequest);
                console.log("Google Sheet Append successful.");
                sheetMessage = 'Data added to Google Sheet.';
            } catch (sheetError) {
                console.error('Error appending to Google Sheet:', sheetError.response ? JSON.stringify(sheetError.response.data) : sheetError.message);
                sheetMessage = `Failed to add data to Google Sheet (${sheetError.message}).`;
            }
        } else if (!SPREADSHEET_ID) {
            sheetMessage = 'Skipped Sheet update (SPREADSHEET_ID not configured).'; console.warn(sheetMessage);
        } else { sheetMessage = 'Skipped Sheet update due to Drive failure.'; }

        // Final Response
        res.status(200).json({
            message: `Upload successful! ${sheetMessage}`,
            fileId: driveFileId,
            fileName: newFilename, // Include filename in response
            ocrDate: extractedData.receiptDate,
            amountEntered: finalAmount
        });

    } catch (error) { // Catch errors from ensureValidToken, Drive, etc.
        console.error('Error during upload process:', error.message, error.stack);
        const status = error.message.includes("Please log in again") || error.message.includes("User not authenticated") ? 401 : 500;
        res.status(status).json({ message: error.message || 'Failed to process upload.' });
    }
});

// --- Helper function findOrCreateFolder ---
async function findOrCreateFolder(drive, folderName, parentId) {
    let folderId = null;
    try {
        const query = `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${folderName}' and '${parentId}' in parents`;
        const response = await drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' });
        if (response.data.files && response.data.files.length > 0) {
            folderId = response.data.files[0].id;
        } else {
            console.log(`Folder '${folderName}' not found, creating...`);
            const fileMetadata = { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] };
            const createResponse = await drive.files.create({ resource: fileMetadata, fields: 'id' });
            folderId = createResponse.data.id;
            console.log(`Folder '${folderName}' created with ID: ${folderId}`);
        }
        return folderId;
    } catch (err) {
        console.error(`Error finding or creating folder '${folderName}':`, err.message);
        return null;
    }
}

// --- Helper Function: Extract Receipt Data (Only Date Extraction relevant now) ---
function extractReceiptData(text) {
    // ... (keep existing function - only date matters now) ...
     let receiptDate = null;
    const dateRegex = /(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}\/\d{4})|(\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4})/i;
    const dateMatch = text.match(dateRegex);
    if (dateMatch) { receiptDate = dateMatch[0]; }
    return { receiptDate: receiptDate || 'N/A' };
}

// --- Start Server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`--------------------------------------------------------------`);
    console.log(`Access locally:      http://localhost:${PORT}`);
    console.log(`--------------------------------------------------------------`);
});