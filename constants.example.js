"use strict";

// Template for constants.js. Copy this file to constants.js and edit the values
// to match your machine:
//
//   cp constants.example.js constants.js   (Windows: copy constants.example.js constants.js)
//
// constants.js is git-ignored so your local paths and connect codes are not
// committed.

const path = require("path");

// Absolute path to the folder that contains your monthly Slippi replay folders
// (e.g. D:/All Slippi Replays/2026-05/...).
const SOURCE_DIR = "D:/All Slippi Replays";

// Where ranked games are copied and grouped. Defaults to a "Ranked" folder under
// SOURCE_DIR; point it elsewhere if you want the output somewhere else.
const DEST_DIR = path.join(SOURCE_DIR, "Ranked");

// Your Slippi connect codes. One of these identifies "you" (player A) in every
// ranked game; the other player is the opponent. Matched case-insensitively.
const MY_CONNECT_CODES = ["ABCD#123", "WXYZ#456"];

module.exports = { SOURCE_DIR, DEST_DIR, MY_CONNECT_CODES };
