export interface AIExecutionToken {
  readonly generation: number;
  readonly targetKey: string;
  readonly controller: AbortController;
}

export class AIExecutionLane {
  private generation = 0;
  private active?: AIExecutionToken;

  begin(targetKey: string): AIExecutionToken {
    this.invalidate();
    const token: AIExecutionToken = {
      generation: this.generation,
      targetKey,
      controller: new AbortController(),
    };
    this.active = token;
    return token;
  }

  isCurrent(token: AIExecutionToken, targetKey = token.targetKey): boolean {
    return (
      this.active === token &&
      token.generation === this.generation &&
      token.targetKey === targetKey &&
      !token.controller.signal.aborted
    );
  }

  complete(token: AIExecutionToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.active = undefined;
    return true;
  }

  invalidate(): void {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = undefined;
  }
}
