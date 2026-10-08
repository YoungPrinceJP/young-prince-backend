import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import OpenAI from "openai";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

/* =========================
   SUPABASE
========================= */

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const COMMUNITY_BUCKET =
    "community-uploads";

/* =========================
   STORAGE PATHS
========================= */

const COMMUNITY_FILES_FOLDER =
    "files";

const COMMUNITY_METADATA_FOLDER =
    "metadata";

const COMMUNITY_THUMBNAILS_FOLDER =
    "thumbnails";

/* =========================
   SUPABASE STORAGE HELPERS
========================= */

async function uploadBufferToCommunityStorage(
    buffer,
    storagePath,
    contentType
) {

    const { error } =
        await supabaseAdmin.storage
            .from(COMMUNITY_BUCKET)
            .upload(
                storagePath,
                buffer,
                {
                    contentType,
                    upsert: true
                }
            );

    if (error) {
        throw error;
    }
}


async function uploadToCommunityStorage(
    filePath,
    storagePath,
    contentType
) {

    const fileBuffer =
        await fs.promises.readFile(
            filePath
        );

    await uploadBufferToCommunityStorage(
        fileBuffer,
        storagePath,
        contentType
    );
}


async function uploadJsonToCommunityStorage(
    storagePath,
    data
) {

    const { error } =
        await supabaseAdmin.storage
            .from(COMMUNITY_BUCKET)
            .upload(
                storagePath,
                JSON.stringify(
                    data,
                    null,
                    2
                ),
                {
                    contentType:
                        "application/json",
                    upsert: true
                }
            );

    if (error) {
        throw error;
    }
}


async function getUploadMetadata(id) {

    const uploadId =
        path.basename(
            String(id)
        );

    const {
        data: metadataFile,
        error: metadataError
    } =
        await supabaseAdmin.storage
            .from(COMMUNITY_BUCKET)
            .download(
                `${COMMUNITY_METADATA_FOLDER}/${uploadId}.json`
            );

    if (metadataError) {
        return null;
    }

    const metadataText =
        await metadataFile.text();

    try {

        return JSON.parse(
            metadataText
        );

    } catch {

        return null;

    }
}


/* =========================
   PUBLIC THUMBNAIL URL
========================= */

function getPublicThumbnailUrl(
    thumbnailPath
) {

    if (!thumbnailPath) {
        return null;
    }

    const {
        data
    } =
        supabaseAdmin.storage
            .from(COMMUNITY_BUCKET)
            .getPublicUrl(
                thumbnailPath
            );

    return data?.publicUrl || null;
}


/* =========================
   IMAGE THUMBNAIL
========================= */

async function createImageThumbnail(
    sourcePath,
    thumbnailPath
) {

    const thumbnailBuffer =
        await sharp(sourcePath)
            .rotate()
            .resize(
                640,
                420,
                {
                    fit: "cover",
                    position: "centre"
                }
            )
            .jpeg({
                quality: 82
            })
            .toBuffer();

    await uploadBufferToCommunityStorage(
        thumbnailBuffer,
        thumbnailPath,
        "image/jpeg"
    );
}


/* =========================
   VIDEO THUMBNAIL
========================= */

async function createVideoThumbnail(
    sourcePath,
    thumbnailPath
) {

    if (!ffmpegPath) {

        throw new Error(
            "FFmpeg is not available."
        );

    }

    const temporaryThumbnail =
        path.join(
            uploadDir,
            `thumb-${crypto
                .randomBytes(8)
                .toString("hex")}.jpg`
        );

    await new Promise(
        (
            resolve,
            reject
        ) => {

            const ffmpeg =
                spawn(
                    ffmpegPath,
                    [
                        "-y",
                        "-ss",
                        "00:00:01",
                        "-i",
                        sourcePath,
                        "-frames:v",
                        "1",
                        "-vf",
                        "scale=640:420:force_original_aspect_ratio=increase,crop=640:420",
                        "-q:v",
                        "3",
                        temporaryThumbnail
                    ],
                    {
                        windowsHide:
                            true
                    }
                );

            let stderr = "";

            ffmpeg.stderr.on(
                "data",
                data => {
                    stderr += data.toString();
                }
            );

            ffmpeg.on(
                "error",
                reject
            );

            ffmpeg.on(
                "close",
                code => {

                    if (
                        code !== 0
                    ) {

                        reject(
                            new Error(
                                `FFmpeg failed: ${stderr}`
                            )
                        );

                        return;
                    }

                    resolve();

                }
            );

        }
    );

    try {

        const thumbnailBuffer =
            await fs.promises.readFile(
                temporaryThumbnail
            );

        await uploadBufferToCommunityStorage(
            thumbnailBuffer,
            thumbnailPath,
            "image/jpeg"
        );

    } finally {

        try {

            await fs.promises.unlink(
                temporaryThumbnail
            );

        } catch {}

    }
}


/* =========================
   GENERATE THUMBNAIL
========================= */

async function generateThumbnailForFile(
    filePath,
    metadata
) {

    const thumbnailPath =
        `${COMMUNITY_THUMBNAILS_FOLDER}/${metadata.id}.jpg`;

    if (
        metadata.mimeType &&
        metadata.mimeType.startsWith(
            "image/"
        )
    ) {

        await createImageThumbnail(
            filePath,
            thumbnailPath
        );

    } else if (
        metadata.mimeType &&
        metadata.mimeType.startsWith(
            "video/"
        )
    ) {

        await createVideoThumbnail(
            filePath,
            thumbnailPath
        );

    } else {

        return null;

    }

    return thumbnailPath;
}


/* =========================
   APP
========================= */

const app = express();

const ADMIN_TOKEN_SECRET =
    process.env.ADMIN_PASSWORD ||
    "change-this-secret";

const PORT =
    Number(
        process.env.PORT ||
        10000
    );

const FRONTEND_ORIGIN =
    process.env.FRONTEND_ORIGIN ||
    "https://youngprincejp.github.io";

const parsedUploadLimit =
    Number.parseInt(
        process.env.MAX_UPLOAD_MB ||
        "25",
        10
    );

const MAX_UPLOAD_MB =
    Number.isFinite(
        parsedUploadLimit
    ) &&
    parsedUploadLimit > 0
        ? parsedUploadLimit
        : 25;

const MAX_UPLOAD_BYTES =
    MAX_UPLOAD_MB *
    1024 *
    1024;

const uploadDir =
    path.join(
        process.cwd(),
        "storage",
        "uploads"
    );

fs.mkdirSync(
    uploadDir,
    {
        recursive: true
    }
);

app.set(
    "trust proxy",
    1
);


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
            FRONTEND_ORIGIN
        ],

        methods: [
            "GET",
            "POST",
            "DELETE",
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

const apiLimiter =
    rateLimit({
        windowMs:
            60 * 1000,

        limit: 30,

        standardHeaders:
            "draft-8",

        legacyHeaders:
            false
    });

const kaelLimiter =
    rateLimit({
        windowMs:
            60 * 1000,

        limit: 10,

        standardHeaders:
            "draft-8",

        legacyHeaders:
            false,

        message: {
            message:
                "Too many Kael requests. Please wait a moment and try again."
        }
    });

app.use(
    "/api",
    apiLimiter
);


/* =========================
   OPENROUTER AI
========================= */

const ai =
    process.env.OPENROUTER_API_KEY
        ? new OpenAI({
            apiKey:
                process.env.OPENROUTER_API_KEY,

            baseURL:
                "https://openrouter.ai/api/v1",

            defaultHeaders: {
                "HTTP-Referer":
                    "https://youngprincejp.github.io",

                "X-Title":
                    "Young Prince"
            }
        })
        : null;


/* =========================
   FILE TYPES
========================= */

const allowedMimeTypes =
    new Set([
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
   TEMPORARY MULTER STORAGE
========================= */

const storage =
    multer.diskStorage({

        destination:
            (_req, _file, callback) => {

                callback(
                    null,
                    uploadDir
                );

            },

        filename:
            (_req, file, callback) => {

                const extension =
                    path.extname(
                        file.originalname
                    )
                    .toLowerCase()
                    .slice(0, 10);

                const filename =
                    `${Date.now()}-${crypto
                        .randomBytes(8)
                        .toString("hex")}${extension}`;

                callback(
                    null,
                    filename
                );

            }
    });

const upload =
    multer({

        storage,

        limits: {
            fileSize:
                MAX_UPLOAD_BYTES
        },

        fileFilter:
            (_req, file, callback) => {

                if (
                    !allowedMimeTypes.has(
                        file.mimetype
                    )
                ) {

                    return callback(
                        new Error(
                            "This file type is not supported."
                        )
                    );

                }

                callback(
                    null,
                    true
                );

            }
    });


/* =========================
   ADMIN AUTHENTICATION
========================= */

app.post(
    "/api/admin/login",
    (req, res) => {

        const password =
            typeof req.body?.password ===
            "string"
                ? req.body.password
                : "";

        if (
            !process.env.ADMIN_PASSWORD
        ) {

            return res.status(503).json({
                message:
                    "Admin authentication is not configured."
            });

        }

        if (
            password !==
            process.env.ADMIN_PASSWORD
        ) {

            return res.status(401).json({
                message:
                    "Invalid admin password."
            });

        }

        const tokenData = {
            role: "admin",
            createdAt: Date.now()
        };

        const payload =
            Buffer.from(
                JSON.stringify(
                    tokenData
                )
            ).toString(
                "base64url"
            );

        const signature =
            crypto
                .createHmac(
                    "sha256",
                    ADMIN_TOKEN_SECRET
                )
                .update(payload)
                .digest(
                    "base64url"
                );

        const token =
            `${payload}.${signature}`;

        return res.json({
            success: true,
            message:
                "Admin login successful.",
            token
        });

    }
);


/* =========================
   HEALTH CHECK
========================= */

app.get(
    "/api/health",
    (_req, res) => {

        res.json({
            ok: true,
            service:
                "young-prince-backend",
            kael:
                Boolean(ai),
            thumbnails:
                true,
            time:
                new Date().toISOString()
        });

    }
);


/* =========================
   KAEL AI — OPENROUTER
========================= */

app.post(
    "/api/kael",
    kaelLimiter,

    async (req, res) => {

        try {

            const message =
                typeof req.body?.message ===
                "string"
                    ? req.body.message.trim()
                    : "";

            if (!message) {

                return res.status(400).json({
                    message:
                        "Please enter a message."
                });

            }

            if (
                message.length > 4000
            ) {

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
                            role:
                                "system",

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
                            role:
                                "user",

                            content:
                                message
                        }
                    ],

                    max_tokens:
                        800
                });

            const reply =
                completion
                    .choices?.[0]
                    ?.message
                    ?.content
                    ?.trim() ||
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
   PUBLIC APPROVED UPLOADS
========================= */

app.get(
    "/api/uploads",
    async (req, res) => {

        try {

            const {
                data,
                error
            } =
                await supabaseAdmin.storage
                    .from(
                        COMMUNITY_BUCKET
                    )
                    .list(
                        COMMUNITY_METADATA_FOLDER,
                        {
                            limit: 100,

                            sortBy: {
                                column:
                                    "name",
                                order:
                                    "desc"
                            }
                        }
                    );

            if (error) {
                throw error;
            }

            const uploads = [];

            for (
                const file of
                data || []
            ) {

                if (
                    !file.name.endsWith(
                        ".json"
                    )
                ) {
                    continue;
                }

                try {

                    const {
                        data:
                            metadataFile,
                        error:
                            downloadError
                    } =
                        await supabaseAdmin
                            .storage
                            .from(
                                COMMUNITY_BUCKET
                            )
                            .download(
                                `${COMMUNITY_METADATA_FOLDER}/${file.name}`
                            );

                    if (
                        downloadError
                    ) {

                        console.error(
                            "METADATA DOWNLOAD ERROR:",
                            downloadError
                        );

                        continue;
                    }

                    const metadataText =
                        await metadataFile.text();

                    const metadata =
                        JSON.parse(
                            metadataText
                        );

                    if (
                        metadata &&
                        metadata.status ===
                            "approved"
                    ) {

                        if (
                            metadata.thumbnailPath
                        ) {

                            metadata.thumbnailUrl =
                                getPublicThumbnailUrl(
                                    metadata.thumbnailPath
                                );

                        }

                        uploads.push(
                            metadata
                        );

                    }

                } catch (
                    parseError
                ) {

                    console.error(
                        "METADATA PARSE ERROR:",
                        parseError
                    );

                }

            }

            uploads.sort(
                (a, b) =>
                    new Date(
                        b.reviewedAt ||
                        b.uploadedAt
                    ) -
                    new Date(
                        a.reviewedAt ||
                        a.uploadedAt
                    )
            );

            return res.json({
                uploads
            });

        } catch (error) {

            console.error(
                "PUBLIC UPLOAD LIST ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "Could not load approved uploads."
            });

        }

    }
);


/* =========================
   PUBLIC THUMBNAIL
========================= */

app.get(
    "/api/uploads/:id/thumbnail",
    async (req, res) => {

        try {

            const metadata =
                await getUploadMetadata(
                    req.params.id
                );

            if (!metadata) {

                return res.status(404).json({
                    message:
                        "Upload not found."
                });

            }

            if (
                metadata.status !==
                "approved"
            ) {

                return res.status(404).json({
                    message:
                        "Thumbnail not available."
                });

            }

            if (
                !metadata.thumbnailPath
            ) {

                return res.status(404).json({
                    message:
                        "Thumbnail not available."
                });

            }

            const {
                data: thumbnailFile,
                error
            } =
                await supabaseAdmin
                    .storage
                    .from(
                        COMMUNITY_BUCKET
                    )
                    .download(
                        metadata.thumbnailPath
                    );

            if (
                error ||
                !thumbnailFile
            ) {

                return res.status(404).json({
                    message:
                        "Thumbnail not found."
                });

            }

            const buffer =
                Buffer.from(
                    await thumbnailFile.arrayBuffer()
                );

            res.setHeader(
                "Content-Type",
                "image/jpeg"
            );

            res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable"
            );

            res.send(buffer);

        } catch (error) {

            console.error(
                "THUMBNAIL ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "Unable to load thumbnail."
            });

        }

    }
);


/* =========================
   PROTECTED ORIGINAL FILE
========================= */

app.get(
    "/api/uploads/:id/file",
    async (req, res) => {

        try {

            const authHeader =
                req.headers.authorization || "";

            if (
                !authHeader.startsWith(
                    "Bearer "
                )
            ) {

                return res.status(401).json({
                    message:
                        "Authentication required."
                });

            }

            const accessToken =
                authHeader.substring(7);

            const {
                data: { user },
                error: authError
            } =
                await supabaseAdmin.auth.getUser(
                    accessToken
                );

            if (
                authError ||
                !user
            ) {

                return res.status(401).json({
                    message:
                        "Invalid or expired session."
                });

            }

            const metadata =
                await getUploadMetadata(
                    req.params.id
                );

            if (!metadata) {

                return res.status(404).json({
                    message:
                        "Upload not found."
                });

            }

            if (
                metadata.status !==
                "approved"
            ) {

                return res.status(404).json({
                    message:
                        "Upload not available."
                });

            }

            const {
                data: fileData,
                error: fileError
            } =
                await supabaseAdmin.storage
                    .from(
                        COMMUNITY_BUCKET
                    )
                    .download(
                        metadata.storagePath
                    );

            if (
                fileError ||
                !fileData
            ) {

                console.error(
                    "COMMUNITY FILE DOWNLOAD ERROR:",
                    fileError
                );

                return res.status(404).json({
                    message:
                        "File not found."
                });

            }

            const buffer =
                Buffer.from(
                    await fileData.arrayBuffer()
                );

            const safeFileName =
                path.basename(
                    metadata.originalName ||
                    metadata.storedName ||
                    "community-file"
                );

            res.setHeader(
                "Content-Type",
                metadata.mimeType ||
                "application/octet-stream"
            );

            res.setHeader(
                "Content-Disposition",
                `inline; filename="${safeFileName}"`
            );

            res.send(buffer);

        } catch (error) {

            console.error(
                "COMMUNITY FILE ERROR:",
                error
            );

            res.status(500).json({
                message:
                    "Unable to access file."
            });

        }

    }
);


/* =========================
   ADMIN AUTH HELPER
========================= */

function verifyAdminToken(req) {

    const authorization =
        req.headers.authorization ||
        "";

    if (
        !authorization.startsWith(
            "Bearer "
        )
    ) {
        return false;
    }

    const token =
        authorization.slice(7);

    const parts =
        token.split(".");

    if (
        parts.length !== 2
    ) {
        return false;
    }

    const [
        payload,
        signature
    ] = parts;

    const expectedSignature =
        crypto
            .createHmac(
                "sha256",
                ADMIN_TOKEN_SECRET
            )
            .update(payload)
            .digest(
                "base64url"
            );

    if (
        signature !==
        expectedSignature
    ) {
        return false;
    }

    try {

        const data =
            JSON.parse(
                Buffer.from(
                    payload,
                    "base64url"
                ).toString(
                    "utf8"
                )
            );

        if (
            data.role !==
            "admin"
        ) {
            return false;
        }

        return true;

    } catch {

        return false;

    }
}


/* =========================
   ADMIN UPLOAD MANAGEMENT
========================= */

app.get(
    "/api/admin/uploads",
    async (req, res) => {

        if (
            !verifyAdminToken(req)
        ) {

            return res.status(401).json({
                message:
                    "Unauthorized."
            });

        }

        try {

            const {
                data,
                error
            } =
                await supabaseAdmin
                    .storage
                    .from(
                        COMMUNITY_BUCKET
                    )
                    .list(
                        COMMUNITY_METADATA_FOLDER,
                        {
                            limit: 100,

                            sortBy: {
                                column:
                                    "name",
                                order:
                                    "desc"
                            }
                        }
                    );

            if (error) {
                throw error;
            }

            const uploads = [];

            for (
                const file of
                data || []
            ) {

                if (
                    !file.name.endsWith(
                        ".json"
                    )
                ) {
                    continue;
                }

                try {

                    const {
                        data:
                            metadataFile,
                        error:
                            metadataError
                    } =
                        await supabaseAdmin
                            .storage
                            .from(
                                COMMUNITY_BUCKET
                            )
                            .download(
                                `${COMMUNITY_METADATA_FOLDER}/${file.name}`
                            );

                    if (
                        metadataError
                    ) {

                        continue;

                    }

                    const metadataText =
                        await metadataFile.text();

                    const metadata =
                        JSON.parse(
                            metadataText
                        );

                    if (metadata) {

                        if (
                            metadata.thumbnailPath
                        ) {

                            metadata.thumbnailUrl =
                                getPublicThumbnailUrl(
                                    metadata.thumbnailPath
                                );

                        }

                        uploads.push(
                            metadata
                        );

                    }

                } catch (
                    metadataParseError
                ) {

                    console.error(
                        "ADMIN METADATA PARSE ERROR:",
                        metadataParseError
                    );

                }

            }

            uploads.sort(
                (a, b) =>
                    new Date(
                        b.uploadedAt
                    ) -
                    new Date(
                        a.uploadedAt
                    )
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

    }
);


/* =========================
   APPROVE UPLOAD
========================= */

app.post(
    "/api/admin/uploads/:id/approve",
    async (req, res) => {

        if (
            !verifyAdminToken(req)
        ) {

            return res.status(401).json({
                message:
                    "Unauthorized."
            });

        }

        const id =
            path.basename(
                String(
                    req.params.id
                )
            );

        try {

            const metadata =
                await getUploadMetadata(
                    id
                );

            if (!metadata) {

                return res.status(404).json({
                    message:
                        "Upload not found."
                });

            }

            metadata.status =
                "approved";

            metadata.reviewedAt =
                new Date().toISOString();

            await uploadJsonToCommunityStorage(
                `${COMMUNITY_METADATA_FOLDER}/${id}.json`,
                metadata
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


/* =========================
   REJECT UPLOAD
========================= */

app.post(
    "/api/admin/uploads/:id/reject",
    async (req, res) => {

        if (
            !verifyAdminToken(req)
        ) {

            return res.status(401).json({
                message:
                    "Unauthorized."
            });

        }

        const id =
            path.basename(
                String(
                    req.params.id
                )
            );

        try {

            const metadata =
                await getUploadMetadata(
                    id
                );

            if (!metadata) {

                return res.status(404).json({
                    message:
                        "Upload not found."
                });

            }

            metadata.status =
                "rejected";

            metadata.reviewedAt =
                new Date().toISOString();

            await uploadJsonToCommunityStorage(
                `${COMMUNITY_METADATA_FOLDER}/${id}.json`,
                metadata
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


/* =========================
   DELETE UPLOAD
========================= */

app.delete(
    "/api/admin/uploads/:id",
    async (req, res) => {

        if (
            !verifyAdminToken(req)
        ) {

            return res.status(401).json({
                message:
                    "Unauthorized."
            });

        }

        const id =
            path.basename(
                String(
                    req.params.id
                )
            );

        try {

            const metadata =
                await getUploadMetadata(
                    id
                );

            if (!metadata) {

                return res.status(404).json({
                    message:
                        "Upload not found."
                });

            }

            const filesToDelete = [];

            if (
                metadata.storagePath
            ) {

                filesToDelete.push(
                    metadata.storagePath
                );

            }

            if (
                metadata.thumbnailPath
            ) {

                filesToDelete.push(
                    metadata.thumbnailPath
                );

            }

            filesToDelete.push(
                `${COMMUNITY_METADATA_FOLDER}/${id}.json`
            );

            const {
                error: deleteError
            } =
                await supabaseAdmin
                    .storage
                    .from(
                        COMMUNITY_BUCKET
                    )
                    .remove(
                        filesToDelete
                    );

            if (deleteError) {
                throw deleteError;
            }

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
   GENERATE MISSING THUMBNAILS
========================= */

app.post(
    "/api/admin/uploads/generate-thumbnails",
    async (req, res) => {

        if (
            !verifyAdminToken(req)
        ) {

            return res.status(401).json({
                message:
                    "Unauthorized."
            });

        }

        try {

            const {
                data,
                error
            } =
                await supabaseAdmin.storage
                    .from(
                        COMMUNITY_BUCKET
                    )
                    .list(
                        COMMUNITY_METADATA_FOLDER,
                        {
                            limit: 100
                        }
                    );

            if (error) {
                throw error;
            }

            let generated = 0;
            let skipped = 0;
            let failed = 0;

            for (
                const file of
                data || []
            ) {

                if (
                    !file.name.endsWith(
                        ".json"
                    )
                ) {
                    continue;
                }

                const id =
                    path.basename(
                        file.name,
                        ".json"
                    );

                try {

                    const metadata =
                        await getUploadMetadata(
                            id
                        );

                    if (!metadata) {
                        skipped++;
                        continue;
                    }

                    if (
                        metadata.thumbnailPath
                    ) {
                        skipped++;
                        continue;
                    }

                    if (
                        !metadata.mimeType ||
                        (
                            !metadata.mimeType.startsWith(
                                "image/"
                            ) &&
                            !metadata.mimeType.startsWith(
                                "video/"
                            )
                        )
                    ) {

                        skipped++;
                        continue;

                    }

                    const {
                        data:
                            originalFile,
                        error:
                            originalError
                    } =
                        await supabaseAdmin.storage
                            .from(
                                COMMUNITY_BUCKET
                            )
                            .download(
                                metadata.storagePath
                            );

                    if (
                        originalError ||
                        !originalFile
                    ) {

                        failed++;
                        continue;

                    }

                    const temporaryOriginal =
                        path.join(
                            uploadDir,
                            `existing-${crypto
                                .randomBytes(8)
                                .toString("hex")}${path.extname(
                                metadata.originalName ||
                                metadata.storedName ||
                                ".tmp"
                            )}`
                        );

                    await fs.promises.writeFile(
                        temporaryOriginal,
                        Buffer.from(
                            await originalFile.arrayBuffer()
                        )
                    );

                    try {

                        const thumbnailPath =
                            await generateThumbnailForFile(
                                temporaryOriginal,
                                metadata
                            );

                        if (
                            thumbnailPath
                        ) {

                            metadata.thumbnailPath =
                                thumbnailPath;

                            metadata.thumbnailUrl =
                                getPublicThumbnailUrl(
                                    thumbnailPath
                                );

                            await uploadJsonToCommunityStorage(
                                `${COMMUNITY_METADATA_FOLDER}/${id}.json`,
                                metadata
                            );

                            generated++;

                        } else {

                            skipped++;

                        }

                    } finally {

                        try {

                            await fs.promises.unlink(
                                temporaryOriginal
                            );

                        } catch {}

                    }

                } catch (error) {

                    failed++;

                    console.error(
                        `THUMBNAIL GENERATION FAILED FOR ${id}:`,
                        error
                    );

                }

            }

            return res.json({
                success: true,
                generated,
                skipped,
                failed
            });

        } catch (error) {

            console.error(
                "GENERATE THUMBNAILS ERROR:",
                error
            );

            return res.status(500).json({
                message:
                    "Could not generate thumbnails."
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
                        req.body?.name ||
                        ""
                    ).slice(
                        0,
                        120
                    ),

                title:
                    String(
                        req.body?.title ||
                        ""
                    ).slice(
                        0,
                        200
                    ),

                category:
                    String(
                        req.body?.category ||
                        ""
                    ).slice(
                        0,
                        50
                    ),

                description:
                    String(
                        req.body?.description ||
                        ""
                    ).slice(
                        0,
                        2000
                    ),

                originalName:
                    req.file.originalname,

                storedName:
                    req.file.filename,

                storagePath:
                    `${COMMUNITY_FILES_FOLDER}/${req.file.filename}`,

                mimeType:
                    req.file.mimetype,

                size:
                    req.file.size,

                uploadedAt:
                    new Date().toISOString(),

                status:
                    "pending",

                thumbnailPath:
                    null

            };


            /* =========================
               UPLOAD ORIGINAL
            ========================= */

            await uploadToCommunityStorage(
                req.file.path,
                metadata.storagePath,
                metadata.mimeType
            );


            /* =========================
               GENERATE THUMBNAIL
            ========================= */

            try {

                const thumbnailPath =
                    await generateThumbnailForFile(
                        req.file.path,
                        metadata
                    );

                if (
                    thumbnailPath
                ) {

                    metadata.thumbnailPath =
                        thumbnailPath;

                    metadata.thumbnailUrl =
                        getPublicThumbnailUrl(
                            thumbnailPath
                        );

                }

            } catch (thumbnailError) {

                console.error(
                    "THUMBNAIL GENERATION ERROR:",
                    thumbnailError
                );

                /*
                 * Thumbnail failure does not
                 * destroy the original upload.
                 */

            }


            /* =========================
               UPLOAD METADATA
            ========================= */

            await uploadJsonToCommunityStorage(
                `${COMMUNITY_METADATA_FOLDER}/${metadata.id}.json`,
                metadata
            );


            /* =========================
               DELETE TEMPORARY FILE
            ========================= */

            try {

                await fs.promises.unlink(
                    req.file.path
                );

            } catch {}


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

            if (
                req.file?.path
            ) {

                try {

                    await fs.promises.unlink(
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
    (
        error,
        _req,
        res,
        _next
    ) => {

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

        console.log(
            `Community thumbnails: enabled`
        );

        console.log(
            `FFmpeg available: ${Boolean(ffmpegPath)}`
        );

    }
);
