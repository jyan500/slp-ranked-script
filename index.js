"use strict";

// Scan a Slippi replays folder, detect which games were ranked, and copy only
// the ranked games into date-organized folders (Ranked/YYYY-MM-DD/).
//
// Usage:
//   node index.js                 Scan ONLY the current month's folder (YYYY-mm)
//   node index.js --all           Scan every month folder under SOURCE_DIR
//   node index.js 2026-04 2026-05 Scan specific month folder(s)
//   node index.js 2026-05-11      Scan/group a specific day (YYYY-MM-DD)
//   node index.js --dry-run       Report what would be copied without copying
//   node index.js --sets          Copy as usual, then group each date folder's
//                                 games into per-opponent "set" subfolders, e.g.
//                                 Ranked/2026-05-02/MyTag (JNOD#789) Falcon vs
//                                 Rival (WXYZ#456) Marth/. Each set subfolder
//                                 also gets a set.json with both players' name,
//                                 code, and per-game character/costume list plus
//                                 the set's date (MM/DD/YYYY).
//   node index.js --real-name     In set.json, use your actual Slippi display
//                                 name for player 0 instead of the configured
//                                 default name (MY_DISPLAY_NAME, "J_Noodles").
//
// Flags can be combined with month filters, e.g. `node index.js 2026-05 --dry-run`.
//
// Re-runs are safe and incremental: existing date folders are reused, and files
// already present in the destination are skipped rather than re-copied. With
// --sets, re-runs are idempotent because games already living inside a matchup
// subfolder are never re-scanned.

const fs = require("fs");
const path = require("path");
const { SlippiGame } = require("@slippi/slippi-js/node");
const { characters } = require("@slippi/slippi-js");

// ---- Configuration ---------------------------------------------------------

// Load local config from constants.js. As an up-front sanity check, fail early
// with a clear message if the file is missing or any required value is absent.
let constants;
try {
    constants = require("./constants");
} catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
        console.error(`Configuration error: constants.js not found next to ${path.basename(__filename)}.`);
        console.error("Create it exporting SOURCE_DIR, DEST_DIR, and MY_CONNECT_CODES.");
        process.exit(1);
    }
    throw err; // a real error inside constants.js (e.g. syntax) — surface it
}

const SOURCE_DIR = constants.SOURCE_DIR;
// DEST_DIR is optional; default to <SOURCE_DIR>/Ranked when not provided.
const DEST_DIR = constants.DEST_DIR ||
    (typeof SOURCE_DIR === "string" ? path.join(SOURCE_DIR, "Ranked") : undefined);
const MY_CONNECT_CODES = constants.MY_CONNECT_CODES;
// Default display name written for player 0 (you) in set.json. Overridable via
// MY_DISPLAY_NAME in constants.js; falls back to the slippi display name if MY_DISPLAY_NAME is an empty string. The --real-name
// flag bypasses this and uses the in-replay Slippi display name instead.
const MY_DISPLAY_NAME = (typeof constants.MY_DISPLAY_NAME === "string" && constants.MY_DISPLAY_NAME.trim())
    ? constants.MY_DISPLAY_NAME.trim()
    : "";

const missingConfig = [];
if (typeof SOURCE_DIR !== "string" || !SOURCE_DIR.trim()) missingConfig.push("SOURCE_DIR");
if (!Array.isArray(MY_CONNECT_CODES) || MY_CONNECT_CODES.length === 0) missingConfig.push("MY_CONNECT_CODES");
if (typeof DEST_DIR !== "string" || !DEST_DIR.trim()) missingConfig.push("DEST_DIR");
if (missingConfig.length > 0) {
    console.error(`Configuration error: missing/invalid value(s) in constants.js: ${missingConfig.join(", ")}`);
    process.exit(1);
}

// A game is ranked when its session id looks like "mode.ranked-...".
const RANKED_PREFIX = "mode.ranked";

// Two consecutive games against the same opponent belong to the same set unless
// more than this much time passes between them (e.g. a later rematch).
const SET_GAP_MS = 30 * 60 * 1000; // 30 minutes

// ---- Argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const scanAll = args.includes("--all");
const groupBySets = args.includes("--sets");
const useRealName = args.includes("--real-name");
const monthFilters = args.filter((a) => /^\d{4}-\d{2}$/.test(a));
const dayFilters = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

// ---- Helpers ---------------------------------------------------------------

// Current month as YYYY-mm in local time, matching the source folder naming.
function currentMonthFolder() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
}

// Whether a YYYY-MM-DD date folder is within the active scope: --all, explicit
// day filters, month filters, or (with no filters) the current month.
function dateFolderInScope(folder) {
    if (scanAll) return true;
    if (dayFilters.length > 0 || monthFilters.length > 0) {
        if (dayFilters.includes(folder)) return true;
        return monthFilters.some((m) => folder.startsWith(`${m}-`));
    }
    return folder.startsWith(`${currentMonthFolder()}-`);
}

// YYYY-MM-DD encoded in a Game_YYYYMMDDT....slp filename, or null. Lets us skip
// out-of-scope files without paying to parse them.
function fileDayFromName(filePath) {
    const m = path.basename(filePath).match(/(\d{4})(\d{2})(\d{2})T/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Recursively collect every .slp file under `dir`, skipping the destination
// folder so we never re-scan files we've already copied.
function findSlpFiles(dir) {
    const results = [];
    const destResolved = path.resolve(DEST_DIR);
    const walk = (current) => {
        if (path.resolve(current) === destResolved) return; // never descend into Ranked/
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (err) {
            console.warn(`  ! Could not read directory ${current}: ${err.message}`);
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".slp")) {
                results.push(full);
            }
        }
    };
    walk(dir);
    return results;
}

// Format a Date into local YYYY-MM-DD (the wall-clock date matches the .slp
// filename, e.g. Game_20260502T231510.slp -> 2026-05-02).
function toLocalDateFolder(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

// Derive the YYYY-MM-DD destination subfolder for a game. Prefer the parsed
// metadata timestamp; fall back to the date encoded in the filename.
function dateFolderFor(game, filePath) {
    const startAt = game.getMetadata() && game.getMetadata().startAt;
    if (startAt) {
        const d = new Date(startAt);
        if (!Number.isNaN(d.getTime())) return toLocalDateFolder(d);
    }
    // Fallback: Game_YYYYMMDDThhmmss.slp (already local time).
    const match = path.basename(filePath).match(/(\d{4})(\d{2})(\d{2})T/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    return "unknown-date";
}

// Epoch-ms start time for a game, used to sort chronologically and measure the
// gap between consecutive games. Prefer metadata startAt; fall back to the
// timestamp encoded in the filename.
function gameStartMs(game, filePath) {
    const startAt = game.getMetadata() && game.getMetadata().startAt;
    if (startAt) {
        const d = new Date(startAt);
        if (!Number.isNaN(d.getTime())) return d.getTime();
    }
    const m = path.basename(filePath).match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (m) {
        const [, y, mo, d, h, mi, s] = m;
        const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
        if (!Number.isNaN(t)) return t;
    }
    return 0;
}

// The HHMMSS portion of a game's filename, used to disambiguate two same-day
// sets against the same opponent.
function fileTimeTag(filePath) {
    const m = path.basename(filePath).match(/T(\d{2})(\d{2})(\d{2})/);
    return m ? `${m[1]}${m[2]}${m[3]}` : "";
}

// Windows-reserved device names that cannot be used as a path component.
const RESERVED_NAMES = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// Make an arbitrary display name safe to use as a single Windows path
// component. Unicode (Japanese, accents, emoji) is valid on NTFS and kept;
// only illegal characters, control chars, trailing dots/spaces, and reserved
// device names are removed. Returns "" if nothing usable remains.
function sanitizeForFolder(name) {
    if (!name) return "";
    let out = String(name)
        .replace(/[<>:"/\\|?*]/g, " ") // Windows-illegal characters
        .replace(/[ -]/g, " ") // ASCII control characters
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, ""); // no trailing dot or space
    if (RESERVED_NAMES.has(out.toUpperCase())) out = `_${out}`;
    return out;
}

// Per-player identity + character for a game. connectCode/displayName come from
// settings, falling back to metadata names; character is the short name (e.g.
// "Falcon") from the external character id; costumeIndex is the in-game costume
// (characterColor) chosen for that character.
function getPlayerInfo(game) {
    const settings = game.getSettings();
    const players = (settings && settings.players) || [];
    const metaPlayers = (game.getMetadata() && game.getMetadata().players) || {};
    const infos = [];
    for (const p of players) {
        if (!p) continue;
        const meta = metaPlayers[p.playerIndex] || {};
        const names = meta.names || {};
        const connectCode = p.connectCode || names.code || "";
        const displayName = p.displayName || names.netplay || "";
        let character = "";
        if (typeof p.characterId === "number") {
            try {
                character = characters.getCharacterShortName(p.characterId) || "";
            } catch (_) {
                character = "";
            }
        }
        const costumeIndex = typeof p.characterColor === "number" ? p.characterColor : null;
        if (!connectCode && !displayName) continue;
        infos.push({ connectCode, displayName, character, costumeIndex });
    }
    return infos;
}

// Identify which player is the user and which is the opponent. Returns
// { me, opponent } (each { connectCode, displayName, character }) or null when
// the game can't be classified (not exactly 2 players, or neither/both match a
// known code) so the file is left untouched.
function classifyMatchup(players) {
    if (players.length !== 2) return null;
    const mine = MY_CONNECT_CODES.map((c) => c.toLowerCase());
    const isMe = (p) => p.connectCode && mine.includes(p.connectCode.toLowerCase());
    const meIdx = players.findIndex(isMe);
    if (meIdx === -1) return null;
    const oppIdx = 1 - meIdx;
    if (isMe(players[oppIdx])) return null; // both matched (shouldn't happen)
    return { me: players[meIdx], opponent: players[oppIdx] };
}

// Distinct character list for one side across a set, in first-appearance order,
// joined with "+" (a literal "/" is illegal in a Windows path).
function charsForSide(games, side) {
    const seen = [];
    for (const g of games) {
        const c = g[side].character;
        if (c && !seen.includes(c)) seen.push(c);
    }
    return seen.join("+");
}

// Ordered list of distinct { character, costumeIndex } a player used across a
// set. Consecutive games on the same character+costume collapse into one entry;
// every switch (including switching back) appends a new entry, so a player who
// never switches yields a single-entry array.
function characterEntriesForSide(games, side) {
    const entries = [];
    for (const g of games) {
        const character = g[side].character || "";
        const costumeIndex = g[side].costumeIndex ?? null;
        if (entries.length === 0) {
            entries.push({ character, costumeIndex });
            continue;
        }
        const last = entries[entries.length - 1];
        if (last.character !== character || last.costumeIndex !== costumeIndex) {
            entries.push({ character, costumeIndex });
        }
    }
    return entries;
}

// Convert a YYYY-MM-DD date-folder name into MM/DD/YYYY for the metadata file.
function dateFolderToMMDDYYYY(folder) {
    const m = folder.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : folder;
}

// Build the per-set metadata object written as set.json: each player keyed by
// 0 (me) and 1 (opponent) with name, code, and the ordered character list, plus
// the set's play date as MM/DD/YYYY.
function buildSetMetadata(games, folder) {
    const playerEntry = (info, side, nameOverride) => ({
        name: nameOverride !== undefined ? nameOverride : (info.displayName || ""),
        code: info.connectCode || "",
        characters: characterEntriesForSide(games, side),
    });
    // Player 0 (you): default to the configured name unless --real-name asks for
    // the actual Slippi display name.
    const myName = useRealName || MY_DISPLAY_NAME === "" ? (games[0].me.displayName || "") : MY_DISPLAY_NAME;
    return {
        0: playerEntry(games[0].me, "me", myName),
        1: playerEntry(games[0].opponent, "opponent"),
        date: dateFolderToMMDDYYYY(folder),
    };
}

// Build the matchup folder name for a grouped set. Name + code come from the
// first game (constant across the set); characters aggregate every game.
function matchupLabel(games) {
    const first = games[0];
    const side = (info, chars, is_me=true) => {
        const name = sanitizeForFolder(is_me ? (useRealName || MY_DISPLAY_NAME === "" ? info.displayName : MY_DISPLAY_NAME) : info.displayName);
        const base = name ? `${name} (${info.connectCode})` : info.connectCode;
        const c = sanitizeForFolder(chars);
        return c ? `${base} ${c}` : base;
    };
    const me = side(first.me, charsForSide(games, "me"), true);
    const opp = side(first.opponent, charsForSide(games, "opponent"), false);
    return sanitizeForFolder(`${me} vs ${opp}`);
}

// Direct child directories of DEST_DIR named YYYY-MM-DD, restricted to the
// active month scope (by YYYY-MM prefix).
function listDateFolders() {
    let entries;
    try {
        entries = fs.readdirSync(DEST_DIR, { withFileTypes: true });
    } catch (_) {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && dateFolderInScope(e.name))
        .map((e) => e.name);
}

// .slp files sitting directly inside `dir` (never recurses into matchup
// subfolders — that is what keeps --sets re-runs idempotent).
function flatSlpFilesIn(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return [];
    }
    return entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".slp"))
        .map((e) => path.join(dir, e.name));
}

// Move a file, falling back to copy+unlink when src and dest are on different
// volumes (rename would throw EXDEV).
function moveFile(src, dest) {
    try {
        fs.renameSync(src, dest);
    } catch (err) {
        if (err.code === "EXDEV") {
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
        } else {
            throw err;
        }
    }
}

// Decide which folders to scan based on the CLI arguments.
function resolveScanRoots() {
    if (scanAll) {
        return [SOURCE_DIR];
    }

    // Months to scan come from explicit month filters plus the months implied by
    // any specific-day filters (a YYYY-MM-DD lives under the YYYY-MM source folder).
    const months = new Set(monthFilters);
    for (const d of dayFilters) months.add(d.slice(0, 7));

    if (months.size > 0) {
        const roots = [];
        for (const m of months) {
            const root = path.join(SOURCE_DIR, m);
            if (fs.existsSync(root)) {
                roots.push(root);
            } else {
                // Source month may be gone (e.g. only re-grouping already-copied
                // days); warn but continue so the group phase can still run.
                console.warn(`  ! Month folder not found, skipping copy from: ${root}`);
            }
        }
        return roots;
    }

    // Default: current month only. Error out if it doesn't exist.
    const month = currentMonthFolder();
    const root = path.join(SOURCE_DIR, month);
    if (!fs.existsSync(root)) {
        console.error(`Current month folder not found: ${root}`);
        console.error(`Use --all to scan every month, or pass a specific month like ${month}.`);
        process.exit(1);
    }
    return [root];
}

// ---- Set grouping (--sets) -------------------------------------------------

// Group a date folder's flat games into sets and move each set into its own
// matchup subfolder. `pendingByFolder` holds would-copy entries from the copy
// phase, needed so a --dry-run preview reflects files not yet on disk.
function groupSets(affectedDateFolders, pendingByFolder, stats) {
    const folders = new Set([...listDateFolders(), ...affectedDateFolders]);

    for (const folder of folders) {
        const dateFolderPath = path.join(DEST_DIR, folder);

        // Collect classifiable games sitting flat in this date folder.
        const games = [];
        for (const filePath of flatSlpFilesIn(dateFolderPath)) {
            let game;
            try {
                game = new SlippiGame(filePath);
                const matchup = classifyMatchup(getPlayerInfo(game));
                if (!matchup) {
                    stats.unclassified++;
                    continue;
                }
                games.push({
                    filePath,
                    basename: path.basename(filePath),
                    startMs: gameStartMs(game, filePath),
                    me: matchup.me,
                    opponent: matchup.opponent,
                });
            } catch (err) {
                stats.errors++;
                console.warn(`  ! Failed to parse ${path.basename(filePath)}: ${err.message}`);
            }
        }

        // In a dry run the would-copy files aren't on disk yet; fold them in so
        // the preview reflects the post-copy state. Dedupe by basename.
        if (dryRun) {
            const present = new Set(games.map((g) => g.basename));
            for (const entry of pendingByFolder.get(folder) || []) {
                if (!present.has(entry.basename)) games.push(entry);
            }
        }

        if (games.length === 0) continue;

        // Chronological order, then break into sets on opponent change or a gap
        // longer than SET_GAP_MS.
        games.sort((a, b) => a.startMs - b.startMs);
        const sets = [];
        for (const g of games) {
            const cur = sets[sets.length - 1];
            const prev = cur && cur[cur.length - 1];
            const sameOpp = prev &&
                prev.opponent.connectCode.toLowerCase() === g.opponent.connectCode.toLowerCase();
            const withinGap = prev && g.startMs - prev.startMs <= SET_GAP_MS;
            if (sameOpp && withinGap) {
                cur.push(g);
            } else {
                sets.push([g]);
            }
        }

        // Move each set into its matchup folder, disambiguating same-label sets
        // (a same-day rematch) with the first game's HHMMSS.
        const usedLabels = new Map(); // label -> first startMs that claimed it
        for (const set of sets) {
            let label = matchupLabel(set);
            const firstMs = set[0].startMs;
            const claimedMs = usedLabels.get(label);
            if (claimedMs !== undefined && claimedMs !== firstMs) {
                const tag = fileTimeTag(set[0].filePath) || String(firstMs);
                label = `${label} [${tag}]`;
            } else {
                usedLabels.set(label, firstMs);
            }

            const destFolder = path.join(dateFolderPath, label);
            stats.sets++;

            for (const g of set) {
                const destPath = path.join(destFolder, g.basename);
                const rel = `${folder}/${label}/${g.basename}`;

                if (fs.existsSync(destPath)) {
                    stats.moveSkipped++;
                    continue;
                }
                if (dryRun) {
                    stats.moved++;
                    console.log(`would move -> ${rel}`);
                    continue;
                }
                try {
                    fs.mkdirSync(destFolder, { recursive: true });
                    moveFile(g.filePath, destPath);
                    stats.moved++;
                    console.log(`moved -> ${rel}`);
                } catch (err) {
                    stats.errors++;
                    console.warn(`  ! Failed to move ${g.basename}: ${err.message}`);
                }
            }

            // Write/refresh the set's metadata file alongside its games.
            const relMeta = `${folder}/${label}/set.json`;
            if (dryRun) {
                stats.jsonWritten++;
                console.log(`would write -> ${relMeta}`);
            } else {
                try {
                    fs.mkdirSync(destFolder, { recursive: true });
                    fs.writeFileSync(
                        path.join(destFolder, "set.json"),
                        JSON.stringify(buildSetMetadata(set, folder), null, 2),
                    );
                    stats.jsonWritten++;
                    console.log(`wrote -> ${relMeta}`);
                } catch (err) {
                    stats.errors++;
                    console.warn(`  ! Failed to write ${relMeta}: ${err.message}`);
                }
            }
        }
    }
}

// ---- Main ------------------------------------------------------------------

function main() {
    if (!fs.existsSync(SOURCE_DIR)) {
        console.error(`Source folder not found: ${SOURCE_DIR}`);
        process.exit(1);
    }

    const scanRoots = resolveScanRoots();

    console.log(`Source:      ${SOURCE_DIR}`);
    console.log(`Destination: ${DEST_DIR}`);
    if (scanAll) {
        console.log("Scope:       ALL months");
    } else if (dayFilters.length > 0 || monthFilters.length > 0) {
        console.log(`Scope:       ${[...monthFilters, ...dayFilters].join(", ")}`);
    } else {
        console.log(`Scope:       ${currentMonthFolder()} (current month)`);
    }
    if (groupBySets) console.log("Sets:        ON (group date folders by opponent)");
    if (groupBySets) {
        console.log(`P0 name:     ${useRealName ? "real Slippi display name" : `"${MY_DISPLAY_NAME}" (default)`}`);
    }
    if (dryRun) console.log("Mode:        DRY RUN (no files will be copied or moved)");
    console.log("");

    const files = scanRoots.flatMap((root) => findSlpFiles(root));
    console.log(`Found ${files.length} .slp file(s) to inspect.\n`);

    const stats = {
        ranked: 0, unranked: 0, copied: 0, skipped: 0, errors: 0,
        sets: 0, moved: 0, moveSkipped: 0, unclassified: 0, jsonWritten: 0,
    };

    // Date folders this run wrote into, and would-copy entries per date folder
    // (used by the group phase, especially for accurate dry-run previews).
    const affectedDateFolders = new Set();
    const pendingByFolder = new Map();

    files.forEach((filePath, i) => {
        const progress = `[${i + 1}/${files.length}]`;

        // Fast scope pre-filter: skip files clearly outside the requested
        // day/month (by filename date) without paying to parse them.
        const nameDay = fileDayFromName(filePath);
        if (nameDay && !dateFolderInScope(nameDay)) return;

        let sessionId;
        let game;
        try {
            game = new SlippiGame(filePath);
            const settings = game.getSettings();
            sessionId = settings && settings.matchInfo && settings.matchInfo.sessionId;
        } catch (err) {
            stats.errors++;
            console.warn(`${progress} ! Failed to parse ${path.basename(filePath)}: ${err.message}`);
            return;
        }

        const isRanked = typeof sessionId === "string" && sessionId.startsWith(RANKED_PREFIX);
        if (!isRanked) {
            stats.unranked++;
            return;
        }
        stats.ranked++;

        const folder = dateFolderFor(game, filePath);
        // Authoritative scope check (covers files whose name lacked a date).
        if (!dateFolderInScope(folder)) return;
        const destFolder = path.join(DEST_DIR, folder);
        const destPath = path.join(destFolder, path.basename(filePath));

        // When grouping, record what this date folder will contain so the group
        // phase can preview a dry run and knows which folders to revisit.
        if (groupBySets) {
            affectedDateFolders.add(folder);
            const matchup = classifyMatchup(getPlayerInfo(game));
            if (matchup) {
                if (!pendingByFolder.has(folder)) pendingByFolder.set(folder, []);
                pendingByFolder.get(folder).push({
                    filePath,
                    basename: path.basename(filePath),
                    startMs: gameStartMs(game, filePath),
                    me: matchup.me,
                    opponent: matchup.opponent,
                });
            }
        }

        if (fs.existsSync(destPath)) {
            stats.skipped++;
            return; // already copied on a previous run
        }

        if (dryRun) {
            stats.copied++;
            console.log(`${progress} would copy -> ${folder}/${path.basename(filePath)}`);
            return;
        }

        try {
            fs.mkdirSync(destFolder, { recursive: true });
            fs.copyFileSync(filePath, destPath);
            stats.copied++;
            console.log(`${progress} copied -> ${folder}/${path.basename(filePath)}`);
        } catch (err) {
            stats.errors++;
            console.warn(`${progress} ! Failed to copy ${path.basename(filePath)}: ${err.message}`);
        }
    });

    if (groupBySets) {
        console.log("\nGrouping date folders into sets...\n");
        groupSets(affectedDateFolders, pendingByFolder, stats);
    }

    console.log("\n--- Summary ---");
    console.log(`Ranked games found:   ${stats.ranked}`);
    console.log(`Unranked games:       ${stats.unranked}`);
    console.log(`${dryRun ? "Would copy:" : "Copied:"}           ${stats.copied}`);
    console.log(`Skipped (existing):   ${stats.skipped}`);
    if (groupBySets) {
        console.log(`Sets formed:          ${stats.sets}`);
        console.log(`${dryRun ? "Would move:" : "Moved into sets:"}      ${stats.moved}`);
        console.log(`Move skipped (exist): ${stats.moveSkipped}`);
        console.log(`Unclassified (flat):  ${stats.unclassified}`);
        console.log(`${dryRun ? "Would write JSON:" : "Set JSON written:"}     ${stats.jsonWritten}`);
    }
    console.log(`Errors:               ${stats.errors}`);
}

main();
