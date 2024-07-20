/**
 * @name WCS-Maestro
 * @author w-AI-fu_DEV
 * @description AI Vtuber Collab Orchestration
 */

const fs = require("fs");
const wcc = require("./wcc");
const openai = require("openai");

let ENV = {
    URL: "",
    USER: "",
    PASS: "",
    ROOM: "",
    OPENAI_KEY: "",
};

const MAX_BACKLOG_AMOUNT = 10;
const SYS_PROMPT =
    "# Dialogue Orchestration\n" +
    "## Goal\n" +
    "Given a dialogue between a variable number of people, " +
    "return the name of the person the last message " +
    "is destined to, or the name of person who *should* " +
    "respond to the last message.\n" +
    "The provided name should never be the same as the person who sent the " +
    "last message.\n" +
    "If the message is not really destined to anyone, try to pick the name of someone who " +
    "hasn't spoken yet from the list of known participants.\n" +
    "If the last message mentions someone in their response, they should be prioritized as " +
    "the person who should be receiving it.\n" +
    "## Response\n" +
    "Your response should only contain the name of the chosen person and " +
    "nothing else. No other commentary needed.\n";

/** @type { wcc.ProtocolMessage[] } */
let dialogue_backlog = [];

/** @typedef { { user: string, name?: string | null } } Participant */

/** @type { Participant[] } */
let known_participants = [];

readEnvFile();

let openai_client = new openai.OpenAI({ apiKey: ENV.OPENAI_KEY });
let client = new wcc();

function log(...args) {
    console.log("MAESTRO:", ...args);
}

function recursiveFetchParticipants() {
    getParticipants().then((arr) => {
        arr.forEach((user) => {
            if (user == ENV.USER) return;

            let is_known = false;
            known_participants.forEach((v) => {
                if (v.user == user) {
                    is_known = true;
                    return;
                }
            });
            if (!is_known) {
                known_participants.push({
                    user: user,
                    name: null,
                });
            }
        });
    });
    log(known_participants);
    setTimeout(recursiveFetchParticipants, 15_000);
}

/**
 * @returns { Promise<string[]> }
 */
async function getParticipants() {
    let url = new URL(ENV.URL);
    url.protocol = "http";
    url.port = "5000";
    url.pathname = "/Websocket";
    url.search = `roomId=${ENV.ROOM}`;

    log("Fetching users...");

    try {
        var resp = await fetch(url, {
            headers: {
                Accept: "application/json",
            },
        });
    } catch {
        log("Error when contacting server for user data.");
        return [];
    }

    try {
        var json = await resp.json();
    } catch {
        log("Error when parsing server user data.");
        return [];
    }

    if (!Array.isArray(json)) {
        log("Received wrong user data from server.");
        return [];
    }

    log("Users:", json);

    return json;
}

/**
 * @returns { void }
 */
function readEnvFile() {
    fs.readFileSync("./.env", { encoding: "utf8" })
        .split(/\r\n|\n/g)
        .forEach((v) => {
            if (v.trim() == "") return;
            let arr = v.split("=");
            ENV[arr[0]] = arr.slice(1, undefined).join("=");
        });
}

/**
 * @param { string } sender
 * @param { string } content
 * @param { wcc.ProtocolMessage } json
 */
async function handleIncomingText(sender, content, json) {
    log("Incoming:", sender, ":", content);

    let is_known = false;

    for (let participant of known_participants) {
        if (participant.user == json.from) {
            is_known = true;
            participant.name = sender;
            break;
        }
    }

    if (!is_known) {
        known_participants.push({
            user: json.from,
            name: sender,
        });
    }

    let target = await decideTarget(json);
    let target_user = null;

    let target_known = false;

    for (let participant of known_participants) {
        if (participant.user == target) {
            target_known = true;
            target_user = participant.user;
            break;
        }
        if (participant.name == target) {
            target_known = true;
            target_user = participant.user;
            break;
        }
    }

    if (!target_known) {
        // Invalid target, dispatch to random known participant
        log("Failed to find target, picking random one.");

        target_user =
            known_participants[randUpTo(known_participants.length)].user;

        let tries = 0;
        while (target_user == json.from && tries < 5) {
            tries++;
            target_user =
                known_participants[randUpTo(known_participants.length)].user;
        }

        if (tries >= 5) {
            target_user = json.from;
        }

        target = target_user;
    }

    if (!target_user) {
        log("Critical: could not find user to send message to.");
        return;
    }

    log("Sending to:", target);

    client.sendText(sender, content, [target_user]);

    for (let known_user of known_participants) {
        if (known_user.user == target_user) continue;
        client.sendData(sender, content, [known_user.user]);
    }
}

/**
 * @param { wcc.ProtocolMessage } json
 * @returns { void }
 */
function appendToBacklog(json) {
    while (dialogue_backlog.length > MAX_BACKLOG_AMOUNT)
        dialogue_backlog.shift();
    dialogue_backlog.push(json);
}

/**
 * @returns { openai.OpenAI.ChatCompletionMessageParam[] }
 */
function getBacklogAsMessages() {
    let result = [];
    for (let json of dialogue_backlog) {
        result.push({
            role: "user",
            name: json.payload.name,
            content: `${json.payload.name}: ${json.payload.content.trim()}`,
        });
    }
    return result;
}

/**
 * @returns { string }
 */
function getSystemPrompt() {
    return (
        SYS_PROMPT +
        "## Known Participants\n" +
        known_participants
            .map((v) => {
                return !v.name ? v.user : v.name;
            })
            .join(", ")
    );
}

/**
 * @param { wcc.ProtocolMessage } json
 * @returns { Promise<string> }
 */
async function decideTarget(json) {
    appendToBacklog(json);
    let prompt_messages = [
        {
            role: "system",
            content: getSystemPrompt(),
        },
        ...getBacklogAsMessages(),
    ];

    let completion_promise = openai_client.chat.completions.create({
        messages: prompt_messages,
        model: "gpt-4o-mini",
        max_tokens: 100,
        temperature: 1.0,
        stream: false,
    });

    try {
        var completion = await completion_promise;
    } catch {
        log("Error while contacting OpenAI.");
        return "";
    }
    return completion.choices[0].message.content ?? "";
}

/**
 * @param { number } x
 * @returns { number }
 */
function randUpTo(x) {
    return Math.floor(Math.random() * x);
}

async function main() {
    client
        .connect(ENV.URL, ENV.ROOM, { user: ENV.USER, pass: ENV.PASS })
        .then(() => {
            client.onTextMessage = handleIncomingText;
            recursiveFetchParticipants();
        })
        .catch((reason) => {
            log("Failed to connect to server. Reason:", reason);
        });

    while (true) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

main();
