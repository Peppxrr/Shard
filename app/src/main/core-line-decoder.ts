import { StringDecoder } from "node:string_decoder";

// Converts arbitrary child-process chunks into complete lines. `finish()` is
// required on close so a final line without a newline is never lost.
export class CoreLineDecoder {
  private decoder = new StringDecoder("utf8");
  private pending = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drainLines();
  }

  finish(): void {
    this.pending += this.decoder.end();
    this.drainLines();
    if (this.pending.length > 0) this.onLine(this.pending);
    this.pending = "";
  }

  private drainLines(): void {
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.onLine(line);
  }
}
