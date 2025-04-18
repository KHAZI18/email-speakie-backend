require("dotenv").config(); // Load environment variables
const express = require("express");
const { google } = require("googleapis");
const cors = require("cors");
const { convert } = require("html-to-text"); // Convert HTML to plain text

const app = express();

// Enable CORS for frontend connection
// app.use(cors({ origin: ["http://localhost:3000"], credentials: true }));
app.use(cors({ 
    origin: [
      "http://localhost:3000", // for local development
      "https://your-frontend-domain.com" // add your deployed frontend URL
    ], 
    credentials: true 
  }));
app.use(express.json());

// Google OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);

// 🔹 Authentication Route
// 🔹 Authentication Route
app.get("/auth", (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.modify"  // Add this scope for delete functionality
        ],
    });
    res.redirect(authUrl);
});
// Update redirect URI for OAuth
app.get("/auth/callback", async (req, res) => {
    try {
      const { code } = req.query;
      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);
      
      // Use environment variable for frontend URL
      const frontendUrl = process.env.NODE_ENV === 'production' 
        ? process.env.FRONTEND_URL 
        : 'http://localhost:3000';
        
      res.redirect(`${frontendUrl}?access_token=${tokens.access_token}`);
    } catch (error) {
      console.error("OAuth2 Error:", error);
      res.status(500).json({ error: "OAuth2 authentication failed" });
    }
  });

// 🔹 OAuth2 Callback
// app.get("/auth/callback", async (req, res) => {
//     try {
//         const { code } = req.query;
//         const { tokens } = await oauth2Client.getToken(code);
//         oauth2Client.setCredentials(tokens);
//         res.redirect(`http://localhost:3000/emails?access_token=${tokens.access_token}`);
//     } catch (error) {
//         console.error("OAuth2 Error:", error);
//         res.status(500).json({ error: "OAuth2 authentication failed" });
//     }
// });

// 🔹 Fetch Emails
// 🔹 Fetch Emails
app.get("/emails", async (req, res) => {
    try {
        const accessToken = req.query.access_token;
        if (!accessToken) return res.status(400).json({ error: "Access token is required" });

        oauth2Client.setCredentials({ access_token: accessToken });
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        const response = await gmail.users.messages.list({ userId: "me", maxResults: 5 });
        if (!response.data.messages) return res.json([]);

        const messages = await Promise.all(
            response.data.messages.map(async (message) => {
                const msg = await gmail.users.messages.get({ userId: "me", id: message.id, format: "full" });

                const headers = msg.data.payload.headers;
                const subject = headers.find((header) => header.name === "Subject")?.value || "No Subject";
                const from = headers.find((header) => header.name === "From")?.value || "Unknown Sender";
                const timestamp = new Date(Number(msg.data.internalDate)).toLocaleString();

                let body = "No Content";

                // Enhanced HTML to text conversion options
                const htmlToTextOptions = {
                    wordwrap: 100,
                    selectors: [
                        { selector: 'a', options: { ignoreHref: true } },
                        { selector: 'img', format: 'skip' }
                    ],
                    preserveNewlines: true,
                    baseElements: {
                        selectors: ['body'],
                        returnDomByDefault: true
                    }
                };

                // Extract body based on MIME type
                if (msg.data.payload.mimeType === 'text/plain' && msg.data.payload.body?.data) {
                    body = Buffer.from(msg.data.payload.body.data, "base64").toString("utf-8");
                } 
                else if (msg.data.payload.mimeType === 'text/html' && msg.data.payload.body?.data) {
                    const htmlBody = Buffer.from(msg.data.payload.body.data, "base64").toString("utf-8");
                    body = convert(htmlBody, htmlToTextOptions);
                } 
                else if (msg.data.payload.parts) {
                    // First try to find plain text part
                    const plainPart = msg.data.payload.parts.find(p => p.mimeType === "text/plain");
                    if (plainPart?.body?.data) {
                        body = Buffer.from(plainPart.body.data, "base64").toString("utf-8");
                    } 
                    // If no plain text, try HTML part
                    else {
                        const htmlPart = msg.data.payload.parts.find(p => p.mimeType === "text/html");
                        if (htmlPart?.body?.data) {
                            const htmlBody = Buffer.from(htmlPart.body.data, "base64").toString("utf-8");
                            body = convert(htmlBody, htmlToTextOptions);
                        }
                        // Handle nested multipart messages
                        else {
                            for (const part of msg.data.payload.parts) {
                                if (part.parts) {
                                    const nestedPlainPart = part.parts.find(p => p.mimeType === "text/plain");
                                    if (nestedPlainPart?.body?.data) {
                                        body = Buffer.from(nestedPlainPart.body.data, "base64").toString("utf-8");
                                        break;
                                    }
                                    
                                    const nestedHtmlPart = part.parts.find(p => p.mimeType === "text/html");
                                    if (nestedHtmlPart?.body?.data) {
                                        const htmlBody = Buffer.from(nestedHtmlPart.body.data, "base64").toString("utf-8");
                                        body = convert(htmlBody, htmlToTextOptions);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                // Clean up the body text
                body = body
                    .replace(/\n{3,}/g, '\n\n')  // Replace multiple newlines with just two
                    .replace(/\s{2,}/g, ' ')     // Replace multiple spaces with one
                    .trim();                     // Remove leading/trailing whitespace

                // Format the readable text with metadata first, to ensure text-to-speech starts with "From"
                const readableText = `From: ${from}\nSubject: ${subject}\nDate: ${timestamp}\n\n${body}`;

                return { 
                    subject, 
                    from, 
                    timestamp, 
                    body,
                    readableText, // Add the formatted text for TTS
                    id: message.id 
                };
            })
        );

        res.json(messages);
    } catch (error) {
        console.error("Error fetching emails:", error);
        res.status(500).json({ error: "Failed to fetch emails", details: error.message });
    }
});



// 🔹 Delete Email (Move to Trash)
// 🔹 Delete Email (Move to Trash)
app.delete("/emails/:emailId", async (req, res) => {
    try {
        // Better token extraction
        const accessToken = req.query.access_token || 
                           (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
                           
        if (!accessToken) {
            return res.status(401).json({ 
                error: "Access token is required",
                details: "No access token provided in query or authorization header" 
            });
        }

        // Set proper credentials and log them (for debugging)
        console.log("Using access token:", accessToken.substring(0, 10) + "...");
        oauth2Client.setCredentials({ access_token: accessToken });
        
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        console.log("Attempting to trash email:", req.params.emailId);
        
        // Attempt the trash operation
        const response = await gmail.users.messages.trash({ 
            userId: "me", 
            id: req.params.emailId 
        });

        console.log("Trash response status:", response.status);
        
        if (response.status === 200) {
            return res.json({ 
                success: true, 
                message: "Email moved to trash",
                emailId: req.params.emailId
            });
        } else {
            throw new Error(`Gmail API returned status code ${response.status}`);
        }
    } catch (error) {
        console.error("Error deleting email:", error);
        
        // More detailed error response
        res.status(error.code === 401 ? 401 : 500).json({ 
            error: "Failed to delete email", 
            details: error.message,
            errorCode: error.code,
            emailId: req.params.emailId
        });
    }
});

// Similarly update the permanent delete endpoint
app.delete("/emails/:emailId/permanent", async (req, res) => {
    try {
        const accessToken = req.query.access_token || 
                           (req.headers.authorization && req.headers.authorization.split(' ')[1]);
                           
        if (!accessToken) return res.status(401).json({ error: "Access token is required" });

        oauth2Client.setCredentials({ access_token: accessToken });
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        const response = await gmail.users.messages.delete({ 
            userId: "me", 
            id: req.params.emailId 
        });

        // Check if the response was successful
        if (response.status !== 204) {
            throw new Error(`Gmail API returned status code ${response.status}`);
        }

        res.json({ success: true, message: "Email permanently deleted" });
    } catch (error) {
        console.error("Error permanently deleting email:", error);
        res.status(500).json({ 
            error: "Failed to delete email", 
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
        });
    }
});

// 🔹 For local development: Start server
if (require.main === module) {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
        console.log(`✅ Server is running on http://localhost:${PORT}`);
    });
}

// Add this endpoint to verify permissions
app.get("/verify-permissions", async (req, res) => {
    try {
        const accessToken = req.query.access_token || 
                           (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
                           
        if (!accessToken) return res.status(401).json({ error: "Access token is required" });

        oauth2Client.setCredentials({ access_token: accessToken });
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        // Get token info
        const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
        
        res.json({ 
            success: true,
            email: tokenInfo.email,
            scopes: tokenInfo.scopes,
            expiresIn: tokenInfo.expiry_date - Date.now()
        });
    } catch (error) {
        console.error("Error verifying permissions:", error);
        res.status(500).json({ error: "Failed to verify permissions", details: error.message });
    }
});

// 🔹 For deployment on Vercel
module.exports = app;
