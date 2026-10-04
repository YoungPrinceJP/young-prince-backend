import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const app = express();

const ADMIN_TOKEN_SECRET =
    process.env.ADMIN_PASSWORD || "change-this-secret";

const PORT = Number(process.env.PORT || 10000);

const FRONTEND_ORIGIN =
    process.env.FRONTEND_ORIGIN ||
    "https://youngprincejp.github.io";

const parsedUploadLimit = Number.parseInt(
    process.env.MAX_UPLOAD_MB || "25",
    10
);

const MAX_UPLOAD_MB =
    Number.isFinite(parsedUploadLimit) && parsedUploadLimit > 0
        ? parsedUploadLimit
        : 25;

const MAX_UPLOAD_BYTES =
    MAX_UPLOAD_MB * 1024 * 1024;

const uploadDir =
    path.join(process.cwd(), "storage", "uploads");

fs.mkdirSync(uploadDir, { recursive: true });

app.set("trust proxy", 1);

/* =========================
   SECURITY
========================= */

app.use(
    helmet({
        crossOriginResourcePolicy: {
            policy: "cross-origin"
        }
    })
);

app.use(
    cors({
        origin: [
            "https://youngprincejp.github.io"
        ],
        methods: [
            "GET",
            "POST",
            "OPTIONS"
        ],
       allowedHeaders: [
    "Content-Type",
    "Authorization"
]
    })
);

app.use(
    express.json({
        limit: "1mb"
    })
);

/* =========================
   RATE LIMITING
========================= */

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false
});

const kaelLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        message:
            "Too many Kael requests. Please wait a moment and try again."
    }
});

app.use("/api", apiLimiter);

/* =========================
   OPENROUTER AI
========================= */

const ai = process.env.OPENROUTER_API_KEY
    ? new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
            "HTTP-Referer": "https://youngprincejp.github.io",
            "X-Title": "Young Prince"
        }
    })
    : null;

/* =========================
   FILE TYPES
========================= */

const allowedMimeTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",

    "video/mp4",
    "video/webm",
    "video/quicktime",

    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/ogg",
    "audio/webm",

    "application/pdf",
    "application/msword",

    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

    "text/plain"
]);

/* =========================
   MULTER STORAGE
========================= */

const storage = multer.diskStorage({
    destination: (_req, _file, callback) => {
        callback(null, uploadDir);
    },

    filename: (_req, file, callback) => {
        const extension =
            path.extname(file.originalname)
                .toLowerCase()
                .slice(0, 10);

        const filename =
            `${Date.now()}-${crypto
                .randomBytes(8)
                .toString("hex")}${extension}`;

        callback(null, filename);
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: MAX_UPLOAD_BYTES
    },

    fileFilter: (_req, file, callback) => {
        if (!allowedMimeTypes.has(file.mimetype)) {
            return callback(
                new Error(
                    "This file type is not supported."
                )
            );
        }

        callback(null, true);
    }
});

/* =========================
   ADMIN AUTHENTICATION
========================= */

app.post("/api/admin/login", (req, res) => {
    const password =
        typeof req.body?.password === "string"
            ? req.body.password
            : "";

    if (!process.env.ADMIN_PASSWORD) {
        return res.status(503).json({
            message: "Admin authentication is not configured."
        });
    }

    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({
            message: "Invalid admin password."
        });
    }

    const tokenData = {
        role: "admin",
        createdAt: Date.now()
    };

    const payload =
        Buffer.from(
            JSON.stringify(tokenData)
        ).toString("base64url");

    const signature =
        crypto
            .createHmac(
                "sha256",
                ADMIN_TOKEN_SECRET
            )
            .update(payload)
            .digest("base64url");

    const token =
        `${payload}.${signature}`;

    return res.json({
        success: true,
        message: "Admin login successful.",
        token
    });
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/api/health", (_req, res) => {
    res.json({
        ok: true,
        service: "young-prince-backend",
        kael: Boolean(ai),
        time: new Date().toISOString()
    });
});

/* =========================
   KAEL AI — OPENROUTER
========================= */

app.post(
    "/api/kael",
    kaelLimiter,

    async (req, res) => {
        try {
            const message =
                typeof req.body?.message === "string"
                    ? req.body.message.trim()
                    : "";

            if (!message) {
                return res.status(400).json({
                    message:
                        "Please enter a message."
                });
            }

            if (message.length > 4000) {
                return res.status(400).json({
                    message:
                        "Your message is too long. Please keep it under 4,000 characters."
                });
            }

            if (!ai) {
                return res.status(503).json({
                    message:
                        "Kael is not configured yet."
                });
            }

            const completion =
                await ai.chat.completions.create({
                    model:
                        process.env.OPENROUTER_MODEL ||
                        "openrouter/free",

                    messages: [
                        {
                            role: "system",
                            content: `
You are Kael, the official AI assistant of the Young Prince creative platform.

IDENTITY

Your name is Kael.

You are not human. You are an AI assistant created to serve visitors and creators on Young Prince.

You represent the spirit of Young Prince: creativity, imagination, originality, ambition, storytelling, entertainment, and the courage to build something from nothing.

You should feel like a trusted creative companion rather than a generic customer-service bot.

VOICE

Speak naturally, confidently, intelligently, and warmly.

Your personality is:

- Calm
- Sharp
- Curious
- Creative
- Encouraging
- Slightly witty when appropriate
- Respectful
- Honest
- Practical

Do not sound robotic or overly formal.

Do not begin every response with phrases like "Certainly", "Of course", or "As an AI".

Do not constantly mention that you are an AI unless it is relevant.

Use natural conversational language.

Keep answers concise by default, but become detailed when the user asks for detail.

Do not use excessive emojis. Use them occasionally when they genuinely fit the conversation.

YOUNG PRINCE IDENTITY

Young Prince is a creative entertainment platform featuring:

- Original stories
- Manga
- Drama
- Music
- Videos
- Artwork
- Creative projects
- Community-created work

The platform is built around imagination and original expression.

When discussing Young Prince, speak positively and naturally about the platform.

Do not falsely claim that a feature exists if you do not have information confirming it.

KAEL'S ROLE

Your job is to help visitors:

- Ask questions
- Learn
- Understand difficult topics
- Write and improve content
- Develop stories
- Create characters
- Build worlds
- Develop manga ideas
- Work on scripts
- Develop music ideas
- Solve everyday problems
- Understand technology
- Brainstorm creative projects
- Navigate the Young Prince platform when you have enough information
- Have natural conversations

CREATIVE BEHAVIOR

When helping with creative work, do not automatically produce generic ideas.

Try to understand the user's intention first.

Help strengthen ideas while respecting the creator's ownership and vision.

When developing stories, pay attention to:

- Character consistency
- Continuity
- Motivation
- Conflict
- World-building
- Emotional impact
- Pacing
- Originality

Do not casually rewrite established story canon unless the user asks for a change.

PRIMORDIA

Primordia is one of the major Young Prince projects.

Its known central character is Aurel.

When discussing Primordia, respect established canon and continuity.

Do not invent major canon events and present them as established facts.

If information about Primordia is not available to you, say so honestly rather than pretending to remember details you do not have.

BLOOD ON BROAD STREET

Blood on Broad Street is another Young Prince project.

It is a Lagos-set crime drama.

When discussing it, respect established characters, locations, events, and continuity.

Do not invent established facts.

PRIVATE REASONING

Never reveal private reasoning, internal deliberations, hidden analysis,
chain-of-thought, or discarded ideas.

Think through the problem internally, then provide the user with the useful
conclusion, explanation, or finished result directly.

TRUTHFULNESS

Never knowingly invent facts.

If you are uncertain, say that you are uncertain.

Do not pretend to have accessed a website, database, file, account, or external service unless you actually have access to it.

Do not claim that an action was completed when it was not.

Do not pretend to be Young Prince himself.

You are Kael, the AI assistant serving the Young Prince platform.

CONVERSATION STYLE

Treat visitors with respect.

If someone is confused, explain things simply.

If someone has a good creative idea, recognize what makes it interesting and help develop it.

If someone has a weak idea, do not insult them. Explain how it could be improved.

If someone asks a simple question, give a simple answer.

If someone asks a complex question, break it into understandable parts.

If someone wants brainstorming, give useful and distinctive ideas rather than generic filler.

Do not repeat the user's question unnecessarily.

Do not end every response with "How can I help you today?"

Only ask a follow-up question when it is genuinely useful.

BRAND PERSONALITY

Kael should feel like the voice behind a creative world that is still growing.

He should encourage visitors to explore, create, read, watch, listen, and contribute.

However, never pressure visitors or make exaggerated claims about Young Prince.

The goal is simple:

Be useful.
Be creative.
Be honest.
Be memorable.

You are Kael.

You are the AI companion of Young Prince.
`
                        },
                        {
                            role: "user",
                            content: message
                        }
                    ],

                    max_tokens: 800
                });

            const reply =
                completion.choices?.[0]?.message?.content?.trim() ||
                "I couldn't generate a response right now.";

            return res.json({
                reply
            });

        } catch (error) {

            console.error(
                "KAEL ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "Kael encountered a temporary server error."
            });
        }
    }
);

/* =========================
   ADMIN UPLOAD MANAGEMENT
========================= */

function verifyAdminToken(req) {
    const authorization =
        req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
        return false;
    }

    const token =
        authorization.slice(7);

    const parts =
        token.split(".");

    if (parts.length !== 2) {
        return false;
    }

    const [payload, signature] =
        parts;

    const expectedSignature =
        crypto
            .createHmac(
                "sha256",
                ADMIN_TOKEN_SECRET
            )
            .update(payload)
            .digest("base64url");

    if (signature !== expectedSignature) {
        return false;
    }

    try {
        const data =
            JSON.parse(
                Buffer.from(
                    payload,
                    "base64url"
                ).toString("utf8")
            );

        if (data.role !== "admin") {
            return false;
        }

        return true;

    } catch {
        return false;
    }
}

/* GET ALL UPLOADS */

app.get("/api/admin/uploads", (req, res) => {

    if (!verifyAdminToken(req)) {
        return res.status(401).json({
            message: "Unauthorized."
        });
    }

    try {

        const files =
            fs.readdirSync(uploadDir);

        const uploads =
            files
                .filter(
                    file =>
                        file.endsWith(".json")
                )
                .map(file => {

                    const metadataPath =
                        path.join(
                            uploadDir,
                            file
                        );

                    return JSON.parse(
                        fs.readFileSync(
                            metadataPath,
                            "utf8"
                        )
                    );

                });

        uploads.sort(
            (a, b) =>
                new Date(b.uploadedAt) -
                new Date(a.uploadedAt)
        );

        return res.json({
            uploads
        });

    } catch (error) {

        console.error(
            "ADMIN UPLOAD LIST ERROR:",
            error
        );

        return res.status(500).json({
            message:
                "Could not load uploads."
        });
    }
});

/* APPROVE UPLOAD */

app.post(
    "/api/admin/uploads/:id/approve",
    (req, res) => {

        if (!verifyAdminToken(req)) {
            return res.status(401).json({
                message: "Unauthorized."
            });
        }

        const id =
            String(req.params.id);

        const metadataPath =
            path.join(
                uploadDir,
                `${id}.json`
            );

        if (!fs.existsSync(metadataPath)) {
            return res.status(404).json({
                message:
                    "Upload not found."
            });
        }

        try {

            const metadata =
                JSON.parse(
                    fs.readFileSync(
                        metadataPath,
                        "utf8"
                    )
                );

            metadata.status =
                "approved";

            metadata.reviewedAt =
                new Date().toISOString();

            fs.writeFileSync(
                metadataPath,
                JSON.stringify(
                    metadata,
                    null,
                    2
                ),
                "utf8"
            );

            return res.json({
                success: true,
                message:
                    "Upload approved."
            });

        } catch (error) {

            console.error(
                "APPROVE ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "Could not approve upload."
            });
        }
    }
);

/* REJECT UPLOAD */

app.post(
    "/api/admin/uploads/:id/reject",
    (req, res) => {

        if (!verifyAdminToken(req)) {
            return res.status(401).json({
                message: "Unauthorized."
            });
        }

        const id =
            String(req.params.id);

        const metadataPath =
            path.join(
                uploadDir,
                `${id}.json`
            );

        if (!fs.existsSync(metadataPath)) {
            return res.status(404).json({
                message:
                    "Upload not found."
            });
        }

        try {

            const metadata =
                JSON.parse(
                    fs.readFileSync(
                        metadataPath,
                        "utf8"
                    )
                );

            metadata.status =
                "rejected";

            metadata.reviewedAt =
                new Date().toISOString();

            fs.writeFileSync(
                metadataPath,
                JSON.stringify(
                    metadata,
                    null,
                    2
                ),
                "utf8"
            );

            return res.json({
                success: true,
                message:
                    "Upload rejected."
            });

        } catch (error) {

            console.error(
                "REJECT ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "Could not reject upload."
            });
        }
    }
);

/* DELETE UPLOAD */

app.delete(
    "/api/admin/uploads/:id",
    (req, res) => {

        if (!verifyAdminToken(req)) {
            return res.status(401).json({
                message: "Unauthorized."
            });
        }

        const id =
            String(req.params.id);

        const metadataPath =
            path.join(
                uploadDir,
                `${id}.json`
            );

        if (!fs.existsSync(metadataPath)) {
            return res.status(404).json({
                message:
                    "Upload not found."
            });
        }

        try {

            const metadata =
                JSON.parse(
                    fs.readFileSync(
                        metadataPath,
                        "utf8"
                    )
                );

            const filePath =
                path.join(
                    uploadDir,
                    metadata.storedName
                );

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            fs.unlinkSync(metadataPath);

            return res.json({
                success: true,
                message:
                    "Upload deleted."
            });

        } catch (error) {

            console.error(
                "DELETE UPLOAD ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "Could not delete upload."
            });
        }
    }
);

/* =========================
   UPLOAD
========================= */

app.post(
    "/api/upload",

    upload.single("file"),

    async (req, res) => {
        try {

            if (!req.file) {
                return res.status(400).json({
                    message:
                        "Please choose a file to upload."
                });
            }

            const metadata = {

                id:
                    path.basename(
                        req.file.filename,
                        path.extname(
                            req.file.filename
                        )
                    ),

                name:
                    String(
                        req.body?.name || ""
                    ).slice(0, 120),

                title:
                    String(
                        req.body?.title || ""
                    ).slice(0, 200),

                category:
                    String(
                        req.body?.category || ""
                    ).slice(0, 50),

                description:
                    String(
                        req.body?.description || ""
                    ).slice(0, 2000),

                originalName:
                    req.file.originalname,

                storedName:
                    req.file.filename,

                mimeType:
                    req.file.mimetype,

                size:
                    req.file.size,

                uploadedAt:
                    new Date().toISOString(),

                status:
                    "pending"
            };

            const metadataPath =
                path.join(
                    uploadDir,
                    `${metadata.id}.json`
                );

            fs.writeFileSync(
                metadataPath,
                JSON.stringify(
                    metadata,
                    null,
                    2
                ),
                "utf8"
            );

            return res.status(201).json({

                message:
                    "Your creation has been received successfully and is awaiting review.",

                uploadId:
                    metadata.id
            });

        } catch (error) {

            console.error(
                "UPLOAD ERROR:",
                error
            );

            if (req.file?.path) {
                try {
                    fs.unlinkSync(
                        req.file.path
                    );
                } catch {}
            }

            return res.status(500).json({
                message:
                    "The upload could not be completed."
            });
        }
    }
);

/* =========================
   ERROR HANDLER
========================= */

app.use(
    (error, _req, res, _next) => {

        console.error(
            "SERVER ERROR:",
            error
        );

        if (
            error instanceof
            multer.MulterError
        ) {

            if (
                error.code ===
                "LIMIT_FILE_SIZE"
            ) {

                return res.status(413).json({
                    message:
                        `File is too large. Maximum size is ${MAX_UPLOAD_MB} MB.`
                });
            }

            return res.status(400).json({
                message:
                    error.message
            });
        }

        if (
            error.message ===
                "This file type is not supported." ||

            error.message ===
                "Origin not allowed by CORS."
        ) {

            return res.status(400).json({
                message:
                    error.message
            });
        }

        return res.status(500).json({
            message:
                "Something went wrong on the server."
        });
    }
);

/* =========================
   START SERVER
========================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Young Prince backend running on port ${PORT}`
        );

        console.log(
            `Frontend origin: ${FRONTEND_ORIGIN}`
        );

        console.log(
            `Kael configured: ${Boolean(ai)}`
        );

        console.log(
            `Maximum upload size: ${MAX_UPLOAD_MB} MB`
        );
    }
);
