import { checkOpenCode } from "./local/opencode.js";
const result = await checkOpenCode();
console.log(JSON.stringify(result, null, 2));
if (!result.available) process.exitCode = 1;
