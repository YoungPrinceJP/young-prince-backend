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

const PORT = Number(process.env.PORT || 10000);

const FRONTEND_ORIGIN =
process.env.FRONTEND_ORIGIN ||
"https://youngprincejp.github.io";

/* =========================
UPLOAD LIMIT
========================= */

const parsedUploadLimit = Number.parseInt(
process.env.MAX_UPLOAD_MB || "25",
10
);

const MAX_UPLOAD_MB =
Number.isFinite(parsedUploadLimit) &&
parsedUploadLimit > 0
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
"Content-Type"
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
GROK / XAI
========================= */

const grok = process.env.XAI_API_KEY
? new OpenAI({
apiKey: process.env.XAI_API_KEY,
baseURL: "https://api.x.ai/v1"
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

```
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
```

]);

/* =========================
MULTER STORAGE
========================= */

const storage = multer.diskStorage({
destination: (_req, _file, callback) => {
callback(null, uploadDir);
},

```
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
```

});

const upload = multer({
storage,

```
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
```

});

/* =========================
HEALTH CHECK
========================= */

app.get("/api/health", (_req, res) => {
res.json({
ok: true,
service: "young-prince-backend",
kael: Boolean(grok),
time: new Date().toISOString()
});
});

/* =========================
KAEL AI — GROK
========================= */

app.post(
"/api/kael",
kaelLimiter,

```
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

        if (!grok) {
            return res.status(503).json({
                message:
                    "Kael is not configured yet."
            });
        }

        const completion =
            await grok.chat.completions.create({
                model:
                    process.env.XAI_MODEL ||
                    "grok-4-1-fast-non-reasoning",

                messages: [
                    {
                        role: "system",
                        content: `
```

You are Kael, the friendly general-purpose AI assistant on the Young Prince website.

Help visitors with:

* Questions
* Explanations
* Writing
* Learning
* Technology
* Creative ideas
* Stories
* Music
* Everyday tasks
* General conversation

Be clear, useful, natural and concise unless the user asks for detail.

Do not claim to be human.

Do not invent facts when you are uncertain.

Young Prince is a creative platform featuring:

* Stories
* Manga
* Drama
* Music
* Videos
* Artwork
* Community-created work

Primordia and Blood on Broad Street are featured projects.

However, Kael is a general-purpose AI and must not restrict its answers to those projects.

If the user asks about Young Prince, explain the platform naturally.

If the user asks about Kael, explain that Kael is the AI assistant powering the Young Prince website.

Always prioritize helpfulness, accuracy, clarity and safety.
`
},
{
role: "user",
content: message
}
],

```
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
```

);

/* =========================
UPLOAD
========================= */

app.post(
"/api/upload",

```
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
```

);

/* =========================
ERROR HANDLER
========================= */

app.use(
(error, _req, res, _next) => {

```
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
```

);

/* =========================
START SERVER
========================= */

app.listen(
PORT,
"0.0.0.0",
() => {

```
    console.log(
        `Young Prince backend running on port ${PORT}`
    );

    console.log(
        `Frontend origin: ${FRONTEND_ORIGIN}`
    );

    console.log(
        `Kael configured: ${Boolean(grok)}`
    );

    console.log(
        `Maximum upload size: ${MAX_UPLOAD_MB} MB`
    );
}
```

);
