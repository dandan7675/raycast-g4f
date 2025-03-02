import { curlFetch, curlFetchNoStream } from "../curl.js";
import { DEFAULT_HEADERS } from "../../helpers/headers.js";
import { messages_to_json } from "../../classes/message.js";

const url = "https://www.phind.com";
const home_url = "https://www.phind.com/search?home=true";
const api_url = "https://https.api.phind.com/infer/";

const headers = {
  ...DEFAULT_HEADERS,
  accept: "*/*",
  origin: url,
  referer: `${url}/search`,
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json;charset=UTF-8",
};

export const PhindProvider = {
  name: "Phind",
  customStream: true,
  models: [{ model: "Phind-70B", stream: true }],
  generate: async function (chat, options, { stream_update }) {
    // get challenge seeds
    let stdout = await curlFetchNoStream(home_url, { method: "GET", headers: headers });

    // capture the object in the form {\"multiplier\":210359,\"addend\":426469,\"modulus\":100823}
    // const regex = /(\{\\?"primes\\?":\{.*?\}\})/;
    const regex = /\{\\"multiplier\\":(\d+),\\"addend\\":(\d+),\\"modulus\\":(\d+)\}/;
    let match = stdout.match(regex);
    match = match[0].replace(/\\/g, "");
    const _data = JSON.parse(match);
    const challenge_seeds = _data;
    if (!challenge_seeds) {
      throw new Error("Could not find challenge seeds");
    }
    stdout = null;

    // prepare data
    chat = messages_to_json(chat);
    let prompt = chat[chat.length - 1].content;
    chat.pop();

    let data = {
      options: {
        allowMultiSearch: true,
        answerModel: "Phind-70B",
        enableNewFollowups: true,
        searchMode: "auto",
        thoughtsMode: "auto",
      },
      question: prompt,
    };

    if (chat.length > 0) {
      data.question_and_answer_history = getChatHistory(chat);
    }

    // get challenge seed
    data.challenge = generateChallenge(data, challenge_seeds);

    const ignore_chunks = [
      "<PHIND_WEBRESULTS>",
      "<PHIND_FOLLOWUP>",
      "<PHIND_METADATA>",
      "<PHIND_INDICATOR>",
      "<PHIND_SPAN_BEGIN>",
      "<PHIND_SPAN_END>",
    ];

    const ignored_tags = ["image", "thinking", "icon", "citation"];

    const special_tags = {};

    let current_tags = [];

    let response = "";

    // POST
    for await (let chunk of curlFetch(api_url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })) {
      const lines = chunk.split("\n");

      for (let line of lines) {
        if (line.startsWith("data: ")) {
          line = line.substring(6);
        } else continue;

        if (line.startsWith("<PHIND_DONE/>")) {
          return;
        }
        if (line.startsWith("<PHIND_BACKEND_ERROR>")) {
          throw new Error();
        }

        let is_ignore = false;
        for (let ignore of ignore_chunks) {
          if (line.startsWith(ignore)) {
            is_ignore = true;
          }
        }

        if (is_ignore) {
          continue;
        }

        if (line) {
          try {
            let json = JSON.parse(line);
            // console.log(json);
            if (json.type === "end_turn") {
              return;
            }

            if (json.type === "new_tag" && json.payload) {
              const tag = json.payload;
              current_tags.push(tag);

              if (special_tags[tag]?.open) {
                response += special_tags[tag].open;
              }
            }

            if (json.type === "end_tag" && json.payload) {
              let tag = json.payload;

              if (special_tags[tag]?.close) {
                response += special_tags[tag].close;
              } else {
                response += "\n";
              }

              let index = current_tags.length - 1;
              while (index >= 0) {
                if (current_tags[index] === tag) {
                  current_tags.splice(index, 1);
                  break;
                }
                index--;
              }
              continue;
            }

            if (json.type === "add_text_token" && json.payload) {
              const payload = json.payload;

              // process tags. if we see an unsupported tag, skip the token
              let skip = false;
              for (let tag of current_tags) {
                if (ignored_tags.includes(tag)) {
                  // console.log(`Skipping due to tag: ${tag}`);
                  skip = true;
                  break;
                }
              }
              if (skip) {
                continue;
              }

              response += payload;
            }
          } catch (e) {
            continue;
          }
        }

        stream_update(response);
      }
    }
  },
};

function deterministicStringify(obj) {
  const handleValue = (value) => {
    if (typeof value === "object" && value !== null) {
      return Array.isArray(value)
        ? `[${value
            .sort()
            .map((item) => handleValue(item))
            .join(",")}]`
        : `{${deterministicStringify(value)}}`;
    } else if (typeof value === "number") {
      return value.toFixed(8).replace(/\.?0+$/, "");
    } else if (typeof value === "boolean") {
      return value ? "true" : "false";
    } else if (typeof value === "string") {
      return `"${value}"`;
    } else {
      return null;
    }
  };

  return Object.keys(obj)
    .sort()
    .reduce((str, key) => {
      const valueStr = handleValue(obj[key]);
      return valueStr !== null ? `${str}${str ? "," : ""}${key}:${valueStr}` : str;
    }, "");
}

function prngGeneral(seed, multiplier, addend, modulus) {
  return ((seed * multiplier + addend) % modulus) / modulus;
}

function linearTransform(x) {
  return 3.87 * x - 0.42;
}

function generateChallengeSeed(obj) {
  const deterministicStr = deterministicStringify(obj);
  const encodedStr = encodeURIComponent(deterministicStr);

  return (function simpleHash(str) {
    let hash = 0;
    const chars = [...str];
    for (let i = 0; i < chars.length; i += 1) {
      if (chars[i].length > 1 || chars[i].charCodeAt(0) >= 256) {
        continue;
      }
      hash = ((hash << 5) - hash + chars[i][0].charCodeAt(0)) | 0;
    }
    return hash;
  })(encodedStr);
}

function generateChallenge(data, challenge_seeds) {
  let challenge = prngGeneral(
    generateChallengeSeed(data),
    challenge_seeds.multiplier,
    challenge_seeds.addend,
    challenge_seeds.modulus
  );
  challenge = linearTransform(challenge);
  return challenge;
}

function getChatHistory(messages) {
  const history = [];

  messages.forEach((message) => {
    if (message.role === "user") {
      history.push({
        question: message.content,
        cancelled: false,
        context: "",
        metadata: {
          mode: "Normal",
          model_name: "Phind Instant",
          images: [],
        },
        customLinks: [],
        multiSearchQueries: [],
        previousAnswers: [],
      });
    } else if (message.role === "assistant") {
      if (history.length > 0) {
        history[history.length - 1].answer = message.content;
      }
    }
  });

  return history;
}
