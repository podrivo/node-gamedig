# DayZ Server Query Protocol

How DayZ server responses are structured, how to parse them, and what to expect.

DayZ uses the **Valve Source Engine A2S protocol** — a UDP-based system for querying game servers — with a **custom binary extension** embedded inside the `A2S_RULES` response for transmitting mod/DLC information. This extension is undocumented by Bohemia Interactive and has been reverse-engineered by the community.

---

## Table of Contents

- [Protocol Overview](#protocol-overview)
- [A2S Data Types](#a2s-data-types)
- [Packet Structure](#packet-structure)
- [Query Flow](#query-flow)
- [A2S_INFO — Server Information](#a2s_info--server-information)
  - [Request](#a2s_info-request)
  - [Response](#a2s_info-response)
  - [Extra Data Flag (EDF)](#extra-data-flag-edf)
  - [DayZ Keywords (Tags)](#dayz-keywords-tags)
- [A2S_PLAYER — Player List](#a2s_player--player-list)
- [A2S_RULES — Server Rules + DayZ Binary Payload](#a2s_rules--server-rules--dayz-binary-payload)
  - [Standard Rules Format](#standard-rules-format)
  - [DayZ Binary Payload (Mod List)](#dayz-binary-payload-mod-list)
  - [Byte Escape Encoding](#byte-escape-encoding)
  - [Binary Payload Structure](#binary-payload-structure)
  - [Parsing the Mod List](#parsing-the-mod-list)
  - [Parsing the Signatures List](#parsing-the-signatures-list)
- [Known Edge Cases](#known-edge-cases)
- [Example: Full Parsed Response](#example-full-parsed-response)
- [Reference Links](#reference-links)

---

## Protocol Overview

DayZ queries use the same A2S protocol as other Source Engine games (CS2, TF2, Rust, etc.) with three query types:

| Query | Request Byte | Response Byte | Purpose |
|---|---|---|---|
| `A2S_INFO` | `0x54` | `0x49` | Server name, map, players, version, tags |
| `A2S_PLAYER` | `0x55` | `0x44` | Connected player names, scores, durations |
| `A2S_RULES` | `0x56` | `0x45` | Server settings + **DayZ mod/DLC binary data** |

All queries are sent as UDP packets to the server's **query port** (default: `27016` for DayZ, which is game port + 1 from the default game port of `2302`).

---

## A2S Data Types

All values are **little-endian**.

| Type | Size | Description |
|---|---|---|
| `byte` | 1 byte | Unsigned 8-bit integer |
| `short` | 2 bytes | Signed 16-bit integer |
| `long` | 4 bytes | Signed 32-bit integer |
| `long long` | 8 bytes | Signed 64-bit integer |
| `float` | 4 bytes | 32-bit floating point |
| `string` | variable | Null-terminated (`0x00`) byte sequence |

---

## Packet Structure

Every A2S packet starts with a **4-byte header**:

- **`0xFFFFFFFF`** (-1): Single packet — all data fits in one UDP datagram
- **`0xFFFFFFFE`** (-2): Split packet — data spans multiple UDP datagrams

For split packets (common with `A2S_RULES` which often exceeds 1400 bytes):

| Field | Type | Description |
|---|---|---|
| Header | long | `0xFFFFFFFE` |
| Request ID | long | Unique ID assigned by server |
| Total Packets | byte | Number of packets in the split |
| Packet Number | byte | Index of this packet (0-based) |
| Size | short | Max packet size (not present in old GoldSrc) |

Split packets must be reassembled in order by `Packet Number` before parsing.

---

## Query Flow

DayZ servers require **challenge-response authentication** to prevent DDoS reflection attacks.

```
Client                          Server
  │                                │
  │  A2S_INFO request              │
  │  FF FF FF FF 54 "Source..."    │
  │ ─────────────────────────────► │
  │                                │
  │  S2C_CHALLENGE (0x41)          │
  │  FF FF FF FF 41 [4-byte key]   │
  │ ◄───────────────────────────── │
  │                                │
  │  A2S_INFO + challenge appended │
  │ ─────────────────────────────► │
  │                                │
  │  A2S_INFO response (0x49)      │
  │ ◄───────────────────────────── │
```

When the server responds with `0x41` (challenge), the 4-byte challenge value must be appended to the original request and resent.

For `A2S_PLAYER` and `A2S_RULES`, the challenge bytes are sent **after** the request type byte:
```
FF FF FF FF 56 [4-byte challenge]
```

For `A2S_INFO`, the challenge bytes are appended **after** the query string:
```
FF FF FF FF 54 "Source Engine Query\0" [4-byte challenge]
```

---

## A2S_INFO — Server Information

### A2S_INFO Request

```
FF FF FF FF 54 53 6F 75 72 63 65 20 45 6E 67 69 6E 65 20 51 75 65 72 79 00
             T  S  o  u  r  c  e     E  n  g  i  n  e     Q  u  e  r  y  \0
```

### A2S_INFO Response

| Field | Type | Description |
|---|---|---|
| Type | byte | `0x49` ("I") |
| Protocol | byte | Protocol version (DayZ uses `17`) |
| Name | string | Server name, e.g. "DayZ US - NY 6053 (1st Person Only)" |
| Map | string | Current map, e.g. "chernarusplus", "enoch" (Livonia), "sakhal" |
| Folder | string | Game directory: "dayz" |
| Game | string | Game description: "DayZ" |
| AppID | short | Steam App ID — `0` for DayZ (221100 exceeds 16-bit max) |
| Players | byte | Current player count |
| Max Players | byte | Max player slots |
| Bots | byte | Number of bot players |
| Server Type | byte | `d` = dedicated, `l` = listen |
| OS | byte | `w` = Windows, `l` = Linux |
| Password | byte | `1` = password required |
| VAC | byte | `1` = VAC secured |
| Version | string | Game version, e.g. "1.26.158962" |
| EDF | byte | Extra Data Flag bitfield |

### Extra Data Flag (EDF)

The EDF byte is a bitfield indicating which additional fields follow. Parse it with bitwise AND:

| Bit Mask | Flag | Field Type | Description |
|---|---|---|---|
| `0x80` | Game Port | short | The server's game port (e.g. 2302) |
| `0x10` | Steam ID | long long | Server's 64-bit Steam ID |
| `0x40` | SourceTV | short + string | SourceTV port and name |
| `0x20` | Keywords | string | Comma-separated tags (see below) |
| `0x01` | Game ID | long long | 64-bit Game ID (lower 24 bits = real App ID) |

The **Game ID** field at `0x01` solves the AppID overflow problem. DayZ's App ID (221100) doesn't fit in a 16-bit short, so the AppID field reads `0`. The true App ID is extracted from the lower 24 bits of Game ID: `gameId & 0xFFFFFF`.

### DayZ Keywords (Tags)

DayZ embeds server configuration inside the keywords string. The string is comma-separated, e.g.:
```
battleye,no3rd,privHive,shard001,lqs0,etm4.200000,entm4.000000,isDLC,14:09
```

| Tag | Meaning |
|---|---|
| `battleye` | BattlEye anti-cheat is enabled |
| `no3rd` | Third-person view is disabled (first-person only) |
| `privHive` | Server uses a private hive database |
| `isDLC` | DLC content is enabled/required on this server |
| `lqs<N>` | Login Queue Size — number of players waiting (e.g. `lqs5` = 5 in queue) |
| `etm<N>` | Day Time Multiplier — time acceleration during daytime (e.g. `etm4.200000`) |
| `entm<N>` | Night Time Multiplier — time acceleration during nighttime (e.g. `entm1.700000`) |
| `shard<N>` | Shard identifier (hive grouping) |
| `HH:MM` | Current in-game time (matches pattern containing `:`) |

**Derived values:**
- **First Person Only**: `no3rd` tag is present
- **Private Hive**: `privHive` tag is present
- **Official Server**: neither `external` nor `privHive` is present
- **External Server**: `external` tag is present

---

## A2S_PLAYER — Player List

### Request
```
FF FF FF FF 55 [4-byte challenge]
```

### Response

| Field | Type | Description |
|---|---|---|
| Type | byte | `0x44` ("D") |
| Num Players | byte | Player count in this response |

For each player:

| Field | Type | Description |
|---|---|---|
| Index | byte | Player index |
| Name | string | Player name |
| Score | long | Player's score / kills |
| Duration | float | Time connected in seconds |

---

## A2S_RULES — Server Rules + DayZ Binary Payload

This is the most complex part. DayZ **hijacks** the standard A2S_RULES key-value format to embed a custom binary payload containing mod and DLC information.

### Request
```
FF FF FF FF 56 [4-byte challenge]
```

### Standard Rules Format

The A2S_RULES response begins with:

| Field | Type | Description |
|---|---|---|
| Type | byte | `0x45` ("E") |
| Num Rules | short | Total number of rule entries |

Each rule is a pair of null-terminated strings:

| Field | Type | Description |
|---|---|---|
| Key | string | Rule name |
| Value | string | Rule value |

For a standard Source game, this would be straightforward key-value pairs. But DayZ does something different.

### DayZ Binary Payload (Mod List)

The **first several "rules"** in the DayZ response are not real key-value pairs — they contain raw binary data encoding mod information, DLC flags, and signature data. These binary entries are identifiable because their keys are 2-byte sequences (not readable strings).

The binary entries have keys like `\x01\x03`, `\x02\x03`, etc. (a 2-byte little-endian index + the total count). After the binary entries, standard text-based rules follow:

| Key | Value | Type |
|---|---|---|
| `\x01\x0A` | `<binary blob>` | Binary — part of mod payload |
| `\x02\x0A` | `<binary blob>` | Binary — continuation |
| ... | ... | ... |
| `allowedBuild` | `"0"` | Standard rule |
| `dedicated` | `"1"` | Standard rule |
| `island` | `"chernarusplus"` | Standard rule |
| `language` | `"65545"` | Standard rule |
| `platform` | `"win"` | Standard rule |
| `requiredBuild` | `"0"` | Standard rule |
| `requiredVersion` | `"126"` | Standard rule |
| `timeLeft` | `"15"` | Standard rule |

### Byte Escape Encoding

The binary payload uses a custom **escape encoding** to avoid null bytes (`0x00`) and the marker byte (`0xFF`), which would break the null-terminated string format of A2S_RULES:

| Byte Sequence | Decoded Value | Reason |
|---|---|---|
| `0x01 0x01` | `0x01` | Literal `0x01` (escape the escape byte) |
| `0x01 0x02` | `0x00` | Encoded null byte (can't use raw `0x00` — it terminates strings) |
| `0x01 0x03` | `0xFF` | Encoded `0xFF` (reserved) |
| Any other byte | itself | Passed through unchanged |

**To decode**: scan the binary data, replacing each `0x01 0xNN` sequence with its decoded value, then parse the resulting raw bytes.

### Binary Payload Structure

After decoding the escape sequences, the binary payload has this structure:

```
┌─────────────────────────────────────────────────────┐
│ Protocol Version     │ 1 byte  │ Always 2            │
├──────────────────────┼─────────┼─────────────────────┤
│ Overflow Flags       │ 1 byte  │ Meaning unknown      │
├──────────────────────┼─────────┼─────────────────────┤
│ DLC Flags            │ 2 bytes │ Bitmask of DLCs      │
├──────────────────────┼─────────┼─────────────────────┤
│ DLC Hashes           │ 4 bytes │ One per set bit in   │
│ (repeated)           │  each   │ DLC Flags            │
├──────────────────────┼─────────┼─────────────────────┤
│ Mods Count           │ 1 byte  │ Number of mod entries│
├──────────────────────┼─────────┼─────────────────────┤
│ Mod Entries           │ variable│ See below           │
│ (repeated)           │         │                     │
├──────────────────────┼─────────┼─────────────────────┤
│ Signatures Count     │ 1 byte  │ Number of signatures │
├──────────────────────┼─────────┼─────────────────────┤
│ Signature Entries    │ variable│ See below            │
│ (repeated)           │         │                      │
└──────────────────────┴─────────┴──────────────────────┘
```

#### DLC Flags

The DLC Flags field is a 2-byte bitmask. Each set bit indicates a DLC is present, and a corresponding 4-byte hash follows. Known values:

| Bit | DLC |
|---|---|
| `0x02` | Frostline |

For each bit set in the DLC Flags, read a 4-byte unsigned integer (the DLC hash).

#### Mod Entries

Each mod entry contains:

| Field | Size | Description |
|---|---|---|
| Mod Hash | 4 bytes | A hash value identifying the mod (not a Steam ID) |
| Workshop ID Length | 1 byte | Length of the workshop ID field (lower 4 bits) |
| Workshop ID | variable | Steam Workshop ID as little-endian unsigned integer |
| Name Length | 1 byte | Length of the mod name string |
| Name | variable | Mod name as UTF-8 string |

The **Workshop ID Length** byte's lower 4 bits (`& 0x0F`) give the number of bytes to read for the workshop ID. Typically this is 4 bytes (a 32-bit unsigned integer).

#### Signature Entries

After the mod entries, there is a flat list of string entries (signatures). These typically contain mod author names, dependency identifiers, and internal mod version strings. They do **not** have workshop IDs.

| Field | Size | Description |
|---|---|---|
| Name Length | 1 byte | Length of the signature name |
| Name | variable | Signature string as UTF-8 |

These are **not** mods — they are metadata like author names (e.g. "Windstride", "Jacob_Mango_V3"), internal mod references (e.g. "cftoolsRoot", "CodeLockv3"), or the base game ("dayz").

### Parsing the Mod List

Step-by-step:

1. **Receive the A2S_RULES response** — handle split packets if needed
2. **Read the rule count** (2-byte short)
3. **Separate binary entries from text entries**: iterate through rules — entries whose keys don't look like normal strings (bytes `!= 0` in positions 0 and 1, followed by `0x00`) are part of the binary payload
4. **Concatenate all binary values** in order (sorted by key)
5. **Apply escape decoding**: replace `0x01 0x01` → `0x01`, `0x01 0x02` → `0x00`, `0x01 0x03` → `0xFF`
6. **Parse the decoded buffer** using the [Binary Payload Structure](#binary-payload-structure) above
7. **Parse remaining text entries** as standard key-value rules

### Parsing the Signatures List

The second section of the binary payload, after the mod entries, contains signatures:

1. Read 1 byte for the count
2. For each signature, read 1 byte for length, then that many bytes for the name string

These signatures typically include mod author names and dependency references. They don't map 1:1 to mods.

---

## Known Edge Cases

### Servers with Rules Disabled
Some DayZ servers have rules queries disabled. The server will simply not respond (timeout). Handle this gracefully.

### DayZ Experimental Servers
Experimental/Unstable branch servers (App ID `1024020`, game name "DayZ Exp") use a different encoding for the rules binary payload. The binary data may be minimal (just `\x01\x01\x01\x02\x01\x02\x01\x02\x01\x02\x01\x01` followed by "dayz") and should be handled as a special case.

### Workshop ID Length Flag Byte
In some server responses, there is an extra byte (value `4`) between the mod hash and the workshop ID that appears inconsistently — present on most mods but missing on the last one in a section. This requires peek-ahead logic: read the byte, and if it's not `4`, rewind the reader.

### Mod Hash Field
The 4-byte "mod hash" field in each mod entry is **not** a Steam ID or author ID — it appears to be an internal hash used for mod identification. It has been referred to as a "mod hash" by the DayZMagicLauncher and is not particularly useful for display purposes.

### Very Large Mod Lists
Servers with many mods (20+) will produce A2S_RULES responses that span multiple split packets. Ensure your implementation correctly reassembles these before attempting to parse.

### Non-ASCII Mod Names
Some mod names contain non-ASCII characters (Cyrillic, etc.). Always decode mod name bytes as UTF-8 with error handling.

---

## Example: Full Parsed Response

Querying a modded DayZ community server would produce:

### A2S_INFO (parsed)
```json
{
  "name": "DayZ US - NY 6053 (1st Person Only)",
  "map": "chernarusplus",
  "folder": "dayz",
  "game": "DayZ",
  "appId": 221100,
  "players": 35,
  "maxPlayers": 60,
  "bots": 0,
  "serverType": "d",
  "os": "w",
  "password": false,
  "vac": true,
  "version": "1.26.158962",
  "gamePort": 2302,
  "steamId": "90172469402110980",
  "tags": ["battleye", "no3rd", "shard001", "lqs0", "etm4.200000", "entm4.000000", "14:09"]
}
```

### DayZ Tags (derived)
```json
{
  "firstPerson": true,
  "privateHive": false,
  "official": true,
  "dlcEnabled": false,
  "queue": 0,
  "dayAcceleration": 4,
  "nightAcceleration": 4,
  "time": "14:09"
}
```

### A2S_RULES — DayZ Mods (parsed)
```json
{
  "dayzMods": [
    {
      "workshopId": 2289456201,
      "title": "Namalsk Island"
    },
    {
      "workshopId": 2289461232,
      "title": "Namalsk Survival"
    }
  ],
  "signatures": [
    "cftoolsRoot",
    "dayz",
    "sumrak"
  ],
  "rules": {
    "allowedBuild": "0",
    "dedicated": "1",
    "island": "chernarusplus",
    "language": "65545",
    "platform": "win",
    "requiredBuild": "0",
    "requiredVersion": "126",
    "timeLeft": "15"
  }
}
```

---

## Reference Links

### Valve / Steam Protocol

- **Valve Developer Wiki — Server Queries**
  https://developer.valvesoftware.com/wiki/Server_queries
  Official A2S protocol documentation (may be behind bot-check).

- **Valve Developer Wiki — Source Server Query Protocol**
  https://developer.valvesoftware.com/wiki/Source_Server_Query_Protocol

- **Cached Valve Wiki (modlink.free.fr)**
  http://modlink.free.fr/cache/48.html
  Accessible cached copy of the Valve wiki page with full protocol tables.

- **qstat — A2S Protocol Reference**
  https://github.com/multiplay/qstat/blob/master/info/a2s.txt
  Complete packet format specification from the original qstat tool.

- **Reactor Wiki — Steam Query Protocol Guide**
  https://wiki.reactor-servers.com/fr/docs/guides/steam-query-protocol/
  Modern overview of A2S with port tables for many games.

### Bohemia Interactive / DayZ

- **Arma 3: ServerBrowserProtocol3 (Bohemia Wiki)**
  https://community.bistudio.com/wiki/Arma_3_ServerBrowserProtocol3
  Bohemia's documentation for the Arma 3 server browser binary protocol. DayZ uses the same format.

- **Arma 3: STEAMWORKSquery (Bohemia Wiki)**
  https://community.bistudio.com/wiki/STEAMWORKSquery
  Steam Workshop mod integration for Arma/DayZ servers.

- **DayZ Server Browsers (velvetcache.org)**
  https://velvetcache.org/2024/05/23/dayz-server-browsers/
  Detailed walkthrough of querying DayZ servers with raw packet hex dumps and byte-by-byte A2S_INFO parsing.

### Community Implementations & Discussions

- **node-gamedig — DayZ Protocol (this project)**
  https://github.com/gamedig/node-gamedig/blob/master/protocols/dayz.js
  JavaScript implementation with byte escape decoding and mod list parsing.

- **node-gamedig Issue #234 — DayZ Rules Weird Chars**
  https://github.com/gamedig/node-gamedig/issues/234
  Original issue and reverse-engineering discussion that led to the current DayZ parser.

- **Yepoleb/dayzquery (Python)**
  https://github.com/Yepoleb/dayzquery
  Python module for decoding the DayZ rules binary response. Clean dataclass-based implementation.

- **Yepoleb/python-a2s Issue #38 — A2S_RULES Decoding**
  https://github.com/Yepoleb/python-a2s/issues/38
  Discussion that led to the creation of dayzquery, with examples of raw binary output.

- **WoozyMasta/a2s (Go)**
  https://github.com/WoozyMasta/a2s
  Go-based A2S utility with DayZ and Arma 3 support.

- **Jadfii/dayzmagiclauncher — query.js**
  https://github.com/Jadfii/dayzmagiclauncher/blob/fc83a80fb461bdb26e6f83f5f4423a9c3ff0aa8a/src/main/query.js
  JavaScript implementation from the DayZ Magic Launcher.

- **GameQ Issue #664 — DayZ Malformed Modlist**
  https://github.com/Austinb/GameQ/issues/664
  PHP library issue with extensive discussion validating mod list accuracy against BattleMetrics and server operator manifests.

- **ValvePython/steam Issue #358 — Binary Rules**
  https://github.com/ValvePython/steam/issues/358
  Discussion about returning A2S_RULES as raw bytes to support DayZ/Arma binary payloads.

- **DaemonForge/DayZ-UniveralApi Issue #2 — Server Queue**
  https://github.com/DaemonForge/DayZ-UniveralApi/issues/2
  Source of documentation for `lqs`, `etm`, `entm` tag meanings.

- **DayZ Forums — Server Tags Demystified**
  https://forums.dayz.com/topic/15359-server-tags-demystified-how-to-find-the-right-server/
  Community guide to DayZ server tag meanings.
