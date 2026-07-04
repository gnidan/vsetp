export type Confusion = Record<string, Record<string, number>>;

export function confusionMatrix(
  pairs: { expected: string; actual: string }[],
): Confusion {
  const matrix: Confusion = {};
  for (const { expected, actual } of pairs) {
    matrix[expected] ??= {};
    matrix[expected][actual] = (matrix[expected][actual] ?? 0) + 1;
  }
  return matrix;
}

export function formatConfusion(matrix: Confusion): string {
  const lines: string[] = [];
  for (const [expected, row] of Object.entries(matrix)) {
    const cells = Object.entries(row)
      .map(([actual, n]) => `${actual}:${n}`)
      .join(" ");
    lines.push(`  expected ${expected} -> ${cells}`);
  }
  return lines.join("\n");
}
