// Similar to the CURL interface, the DDGS interface is used to communicate
// with the `ddgs` CLI to perform DuckDuckGo searches.
// REQUIREMENT: `pip install duckduckgo-search` in order to install the `ddgs` CLI.

import { DEFAULT_SHELL_OPTIONS, execShellNoStream } from "#root/src/api/shell.js";
import { escapeString } from "#root/src/helpers/helper.js";
import { getSupportPath } from "#root/src/helpers/extension_helper.js";
import fs from "fs";

// Return an array of the search results.
// Each result is of the form: {title, href, body}
export async function ddgsRequest(query, { maxResults = 15 } = {}) {
  query = escapeString(query);

  const ddgs_cmd = `ddgs text -k '${query}' -s off -m ${maxResults} -o "ddgs_results.json"`;
  const cwd = getSupportPath();

  await execShellNoStream(ddgs_cmd, { ...DEFAULT_SHELL_OPTIONS, cwd });

  let results = fs.readFileSync(`${cwd}/ddgs_results.json`, "utf8");
  results = JSON.parse(results);

  // clean up the file
  fs.writeFileSync(`${cwd}/ddgs_results.json`, "");

  return results;
}