const express = require("express");
const app = express();
const mongoose = require("mongoose");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

const log = require("./structs/log.js");
const error = require("./structs/error.js");
const functions = require("./structs/functions.js");

// Create required directories.
fs.mkdirSync("./Config", { recursive: true });
fs.mkdirSync("./ClientSettings", { recursive: true });
fs.mkdirSync("./tokenManager", { recursive: true });

// Create default configuration if the private file is missing.
const configPath = "./Config/config.json";

if (!fs.existsSync(configPath)) {
    const defaultConfig = {
        moderators: [],
        discord: {
            bot_token: process.env.DISCORD_BOT_TOKEN || "",
            useDiscordBot: process.env.DISCORD_USE_BOT === "true"
        },
        mongodb: {
            database: process.env.MONGODB_URI || ""
        },
        chat: {
            EnableGlobalChat: false
        },
        matchmakerIP: process.env.MATCHMAKER_IP || "127.0.0.1:80",
        gameServerIP: process.env.GAME_SERVER_IP || "127.0.0.1:7777"
    };

    fs.writeFileSync(
        configPath,
        JSON.stringify(defaultConfig, null, 2)
    );
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

// Use a stable hosting secret when provided.
global.JWT_SECRET = process.env.JWT_SECRET || functions.MakeID();

// Use Render's assigned port or 8080 locally.
const PORT = Number(process.env.PORT) || 8080;

// Create an empty token file if it does not exist.
const tokensPath = "./tokenManager/tokens.json";

if (!fs.existsSync(tokensPath)) {
    fs.writeFileSync(
        tokensPath,
        JSON.stringify({
            accessTokens: [],
            refreshTokens: [],
            clientTokens: []
        }, null, 2)
    );
}

// Load saved tokens.
const tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8"));

tokens.accessTokens ||= [];
tokens.refreshTokens ||= [];
tokens.clientTokens ||= [];

// Remove expired tokens.
for (const tokenType of ["accessTokens", "refreshTokens", "clientTokens"]) {
    for (let i = tokens[tokenType].length - 1; i >= 0; i--) {
        const entry = tokens[tokenType][i];

        if (!entry || typeof entry.token !== "string") continue;

        const decoded = jwt.decode(entry.token.replace(/^eg1~/, ""));

        if (
            !decoded ||
            !decoded.creation_date ||
            !Number.isFinite(Number(decoded.hours_expire))
        ) {
            continue;
        }

        const expiry = new Date(decoded.creation_date);
        expiry.setHours(expiry.getHours() + Number(decoded.hours_expire));

        if (!Number.isNaN(expiry.getTime()) && expiry.getTime() <= Date.now()) {
            tokens[tokenType].splice(i, 1);
        }
    }
}

// Save the cleaned tokens.
fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));

global.accessTokens = tokens.accessTokens;
global.refreshTokens = tokens.refreshTokens;
global.clientTokens = tokens.clientTokens;
global.exchangeCodes = [];

// MongoDB configuration.
mongoose.set("strictQuery", false);

const mongoUri = process.env.MONGODB_URI || config.mongodb.database;

if (!mongoUri || mongoUri === "REDACTED") {
    log.error("MongoDB connection string is missing. Set MONGODB_URI in the hosting environment.");
    process.exit(1);
}

// Connect to MongoDB.
mongoose.connect(mongoUri)
    .then(() => {
        log.backend("App successfully connected to MongoDB!");
    })
    .catch(err => {
        log.error("MongoDB connection failed. Check your connection settings.");
        console.error(err.message);
        process.exit(1);
    });

// Express middleware.
app.use(rateLimit({
    windowMs: 0.5 * 60 * 1000,
    max: 45
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load API routes.
fs.readdirSync("./routes")
    .filter(fileName => fileName.endsWith(".js"))
    .forEach(fileName => {
        app.use(require(`./routes/${fileName}`));
    });

// Handle missing endpoints.
app.use((req, res) => {
    console.log(`Missing endpoint: ${req.method} ${req.originalUrl}`);

    error.createError(
        "errors.com.epicgames.common.not_found",
        "Sorry the resource you were trying to find could not be found",
        undefined,
        1004,
        undefined,
        404,
        res
    );
});

// Start the main HTTP server.
const server = app.listen(PORT, "0.0.0.0", () => {
    global.apexHttpServer = server;
    log.backend(`App started listening on port ${PORT}`);

    require("./xmpp/xmpp.js");

    if (config.discord.useDiscordBot === true) {
        require("./DiscordBot");
    }
});

server.on("error", async err => {
    if (err.code === "EADDRINUSE") {
        log.error(`Port ${PORT} is already in use!`);

        await functions.sleep(3000);
        process.exit(0);
    } else {
        throw err;
    }
});