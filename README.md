# SLP Ranked Script
Scan a Slippi replays folder, and copy only
the ranked games into date-organized folders (Ranked/YYYY-MM-DD/). Can also
group the ranked games into their respective sets.

# Installation

Make sure you have node installed (confirmed to work on at least 22.17.1),
and npm installed (confirmed on at least 6.14.8)

`npm install`

Copy the constants.example.js into a new `constants.js` file, and update the following three variables:

`SOURCE_DIR` = "Path to your slippi replays grouped by month";

`DEST_DIR` = "Path where the ranked games will go (defaults to the SOURCE_DIR under a directory named "Ranked" (i.e C:\Your Slippi Replays\Ranked))

`MY_CONNECT_CODES` = [Your connect code 1, Your connect code 2, ...] // Can enter multiple if you play on more than one account

`MY_DISPLAY_NAME` = "Your name" // Optional. The name written for you (player 0)
in each set's `set.json`. Defaults to a given user name defined in constants.js
when omitted. Use `--real-name` (see Usage) to override this with your actual
in-replay Slippi display name instead.

# Usage

`$ node index.js`                 Scan ONLY the current month's folder (YYYY-mm)

`$ node index.js --all`           Scan every month folder under SOURCE_DIR

`$ node index.js 2026-04 2026-05` Scan specific month folder(s)

`$ node index.js 2026-05-11`      Scan/group a specific day (YYYY-MM-DD)

`$ node index.js --dry-run`       Report what would be copied without copying

`$ node index.js --sets`          Copy as usual, then group each date folder's
                                games into per-opponent "set" subfolders, e.g.
                                Ranked/2026-05-02/MyTag (ABCD#789) Falcon vs
                                Rival (WXYZ#456) Marth/.

`$ node index.js --real-name`     In each set's `set.json`, use your actual
                                Slippi display name for player 0 instead of the
                                configured `MY_DISPLAY_NAME` (which defaults to a
                                given user name defined in constants.js). Only
                                affects `set.json`, so use it together with
                                `--sets`.

Flags can be combined with month filters, e.g. `node index.js 2026-05 --dry-run`.
Re-runs are safe and incremental: existing date folders are reused, and files
already present in the destination are skipped rather than re-copied. 
Games that are already living inside a matchup subfolder are never re-scanned.
