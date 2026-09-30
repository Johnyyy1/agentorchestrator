import { execa } from "execa";

export type AntigravityResult = {
  success: boolean;
  exitCode: number;
  output: unknown;
  stderr: string;
};

export async function runAntigravity(
  prompt: string,
  cwd: string,
  model?: string,
): Promise<AntigravityResult> {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--print-timeout",
    "2m",
  ];

  if (model) {
    args.push("--model", model);
  }

  const result = await execa(
    "agy",
    args,
    {
      cwd,
      reject: false,
      stdin: "ignore",
      timeout: 120_000,
    },
  );

  let output: unknown = result.stdout;

  try {
    output = JSON.parse(result.stdout);
  } catch {
    // keep raw stdout if JSON parsing fails
  }

  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode ?? 1,
    output,
    stderr: result.stderr.trim(),
  };
}