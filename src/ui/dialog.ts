import { Surface } from '../engine/surface';
import { viewport } from '../engine/viewport';
import type { InputEvent } from '../engine/input';
import type { EventPortrait } from '../events/event-portrait';
import { FONT as BMP_FONTS, areFontsReady } from '../rendering/bmp-font';

export type DialogState = 'transition_in' | 'typing' | 'waiting' | 'done';

const FONT = '8px monospace';
const SPEAKER_FONT = '8px monospace';
const BOX_HEIGHT = 40;
const BOX_MARGIN = 2;
const INNER_PAD = 4;
const LINE_HEIGHT = 10;
/** Default LT text speed (milliseconds per character). */
const DEFAULT_TEXT_SPEED_MS = 32;
/** Default LT dialog speed multiplier (1 = normal). */
const DEFAULT_SPEED_MULT = 1;

/** Minimum box height (2 lines of text + padding). */
const MIN_BOX_HEIGHT = 40;

const BG_COLOR = 'rgba(12, 12, 28, 0.92)';
const BORDER_COLOR = 'rgba(160, 160, 200, 0.5)';
const SPEAKER_COLOR = 'rgba(255, 220, 80, 1)';
const TEXT_COLOR = 'white';

/**
 * Shared offscreen canvas for measuring text width.
 * Created lazily on first use.
 */
let _measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function getMeasureCtx(): OffscreenCanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = new OffscreenCanvas(1, 1);
    _measureCtx = c.getContext('2d')!;
  }
  return _measureCtx;
}

/** Measure text pixel width using BMP fonts when available, else Canvas. */
function measureTextWidth(text: string, font: string): number {
  // Try BMP font width measurement first
  if (areFontsReady()) {
    const bmpFont = BMP_FONTS['text'];
    if (bmpFont) return bmpFont.width(text);
  }
  const ctx = getMeasureCtx();
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Word-wrap a string to fit within `maxWidth` pixels using `font`.
 * Returns an array of lines. Preserves existing newlines.
 */
function wordWrap(text: string, maxWidth: number, font: string): string[] {
  const result: string[] = [];
  // First split on explicit newlines
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    if (para === '') {
      result.push('');
      continue;
    }
    const words = para.split(' ');
    let currentLine = '';
    for (const word of words) {
      if (currentLine === '') {
        // First word on the line — always place it (even if too wide)
        currentLine = word;
      } else {
        const testLine = currentLine + ' ' + word;
        if (measureTextWidth(testLine, font) <= maxWidth) {
          currentLine = testLine;
        } else {
          result.push(currentLine);
          currentLine = word;
        }
      }
    }
    result.push(currentLine);
  }
  return result;
}

/** Speech bubble tail height. */
const TAIL_HEIGHT = 6;

/**
 * Dialog - Text box for character speech/narration.
 * Supports typewriter effect, wait for input, and line breaks.
 * Inline commands: {w} = wait for input, {br} = line break, | = wait + break
 */
export class Dialog {
  private text: string;
  private displayedText: string;
  private charIndex: number;
  private speaker: string;
  private state: DialogState;
  private textSpeedMs: number;
  private speedMult: number;
  private startingSpeedMult: number;
  private frameCounter: number;
  private charProgress: number;
  private waitingForInput: boolean;
  private lines: string[];
  private currentLine: number;

  /** Optional portrait for speech bubble positioning. */
  private portrait: EventPortrait | null;
  /** Whether to clear displayed text on next input (from {clear} tag). */
  private _clearOnResume: boolean = false;

  /** Transition-in progress 0..1 (matching Python's ~167ms / 10 frames). */
  private transitionProgress: number = 0;
  private static readonly TRANSITION_DURATION_MS = 167; // 10 frames at 60fps

  constructor(
    text: string,
    speaker?: string,
    portrait?: EventPortrait,
    textSpeedMs?: number,
    speedMult?: number,
  ) {
    this.text = text;
    this.displayedText = '';
    this.charIndex = 0;
    this.speaker = speaker ?? '';
    this.state = 'transition_in';
    this.textSpeedMs = textSpeedMs ?? DEFAULT_TEXT_SPEED_MS;
    this.speedMult = speedMult ?? DEFAULT_SPEED_MULT;
    this.startingSpeedMult = this.speedMult;
    this.frameCounter = 0;
    this.charProgress = 0;
    this.waitingForInput = false;
    this.currentLine = 0;
    this.portrait = portrait ?? null;

    // Pre-process the text into logical segments split by | (wait+break)
    // We keep {w} and {br} inline for the typewriter to encounter.
    this.lines = this.text.split('|');
  }

  /** Process input. Returns true when dialog is complete. */
  handleInput(event: InputEvent): boolean {
    if (event === null) return false;

    if (event === 'SELECT') {
      // Skip transition if still transitioning in
      if (this.state === 'transition_in') {
        this.transitionProgress = 1;
        this.state = 'typing';
        return false;
      }
      if (this.state === 'typing') {
        // Skip to end of current line
        this._finishCurrentLine();
        return false;
      }
      if (this.state === 'waiting') {
        // If {clear} was triggered, clear text and continue typing same line
        if (this._clearOnResume) {
          this._clearOnResume = false;
          this.displayedText = '';
          this.state = 'typing';
          this.waitingForInput = false;
          return false;
        }
        // Advance to next line or finish
        if (this.currentLine < this.lines.length - 1) {
          this.currentLine++;
          this.charIndex = 0;
          this.displayedText = '';
          this.state = 'typing';
          this.waitingForInput = false;
        } else {
          this.state = 'done';
          return true;
        }
        return false;
      }
      if (this.state === 'done') {
        return true;
      }
    }

    if (event === 'BACK') {
      // Skip entire dialog
      this._skipAll();
      return true;
    }

    return false;
  }

  /** Update typewriter effect. `deltaMs` is elapsed time since last frame. */
  update(deltaMs: number = 1000 / 60): void {
    // Handle transition_in: advance progress until complete, then start typing
    if (this.state === 'transition_in') {
      // ~16.67ms per frame at 60fps
      this.transitionProgress = Math.min(1, this.transitionProgress + (1000 / 60) / Dialog.TRANSITION_DURATION_MS);
      if (this.transitionProgress >= 1) {
        this.transitionProgress = 1;
        this.state = 'typing';
      }
      return;
    }

    if (this.state !== 'typing') return;

    const baseTextSpeed = Number.isFinite(this.textSpeedMs)
      ? this.textSpeedMs
      : DEFAULT_TEXT_SPEED_MS;
    const localSpeedMult = Number.isFinite(this.speedMult)
      ? this.speedMult
      : this.startingSpeedMult;
    const effectiveTextSpeed = baseTextSpeed * localSpeedMult;
    const instant = effectiveTextSpeed <= 0;

    if (!instant) {
      this.charProgress += deltaMs / effectiveTextSpeed;
    }

    while ((instant || this.charProgress >= 1) && this.state === 'typing') {
      if (!instant) {
        this.charProgress -= 1;
      }

      const currentLineText = this.lines[this.currentLine] ?? '';
      if (this.charIndex >= currentLineText.length) {
        // End of current line segment
        if (this.currentLine < this.lines.length - 1) {
          // There's another segment after this | separator — wait for input
          this.state = 'waiting';
          this.waitingForInput = true;
        } else {
          this.state = 'waiting';
          this.waitingForInput = true;
        }
        this.charProgress = 0;
        return;
      }

      // Check for inline commands
      const remaining = currentLineText.slice(this.charIndex);

      if (remaining.startsWith('{w}')) {
        // Wait for input
        this.charIndex += 3;
        this.state = 'waiting';
        this.waitingForInput = true;
        this.charProgress = 0;
        return;
      }

      if (remaining.startsWith('{br}')) {
        // Line break
        this.charIndex += 4;
        this.displayedText += '\n';
        continue;
      }

      if (remaining.startsWith('{clear}')) {
        // Clear the text box and wait for input before continuing
        this.charIndex += 7;
        this.state = 'waiting';
        this.waitingForInput = true;
        this._clearOnResume = true;
        this.charProgress = 0;
        return;
      }

      if (remaining.startsWith('{p}')) {
        // Brief pause (auto-continues) — treat as short wait
        this.charIndex += 3;
        this.state = 'waiting';
        this.waitingForInput = true;
        this.charProgress = 0;
        return;
      }

      if (remaining.startsWith('{max_speed}')) {
        this.charIndex += '{max_speed}'.length;
        this.speedMult = 0;
        continue;
      }

      if (remaining.startsWith('{starting_speed}')) {
        this.charIndex += '{starting_speed}'.length;
        this.speedMult = this.startingSpeedMult;
        continue;
      }

      const speedMatch = remaining.match(/^\{speed:(\d+(?:\.\d+)?)\}/);
      if (speedMatch) {
        this.charIndex += speedMatch[0].length;
        this.speedMult = Number(speedMatch[1]);
        continue;
      }

      // {c:command;arg1;arg2} — inline event command (skip silently)
      if (remaining.startsWith('{c:')) {
        const endIdx = remaining.indexOf('}');
        if (endIdx !== -1) {
          this.charIndex += endIdx + 1;
          continue;
        }
      }

      // Skip other unrecognized {tags}
      if (remaining.startsWith('{')) {
        const endIdx = remaining.indexOf('}');
        if (endIdx !== -1) {
          this.charIndex += endIdx + 1;
          continue;
        }
      }

      // Normal character
      this.displayedText += currentLineText[this.charIndex];
      this.charIndex++;
    }
  }

  /** Draw the dialog box */
  draw(surf: Surface): void {
    if (this.state === 'done') return;

    const isTransitionIn = this.state === 'transition_in';
    const transT = this.transitionProgress;

    // Compute box position — either relative to portrait or at bottom
    let boxX: number;
    let boxW: number;
    let tailX: number | null = null; // Speech bubble tail X position

    // Compute text width first to determine box size (matching Python's auto-sizing)
    // We need a preliminary wrap at max width to know the actual text extent.
    const maxBoxW = viewport.width - 8;
    const prelimAvailW = maxBoxW - INNER_PAD * 2;
    const wrappedLines = wordWrap(this.displayedText, prelimAvailW, FONT);

    // Count how many lines we need (speaker + text lines)
    const speakerLines = this.speaker ? 1 : 0;
    const totalLines = speakerLines + wrappedLines.length;
    const boxH = Math.max(MIN_BOX_HEIGHT, totalLines * LINE_HEIGHT + INNER_PAD * 2);

    if (this.portrait) {
      // Auto-size width to text content (matching Python's determine_size())
      const speakerW = this.speaker ? measureTextWidth(this.speaker, SPEAKER_FONT) : 0;
      const maxLineW = wrappedLines.reduce(
        (max, line) => Math.max(max, measureTextWidth(line, FONT)),
        0,
      );
      const contentW = Math.max(speakerW, maxLineW) + INNER_PAD * 2 + 8;
      // Minimum 80px wide for short lines, maximum full viewport width
      boxW = Math.min(maxBoxW, Math.max(80, contentW));

      const portraitCenter = this.portrait.getDesiredCenter();
      if (boxW >= viewport.width - 8) {
        // Wide dialog: fixed at x=4 (matching Python)
        boxX = 4;
      } else {
        // Center dialog on portrait's desired center
        boxX = Math.max(8, Math.min(portraitCenter - boxW / 2, viewport.width - 8 - boxW));
      }
      tailX = Math.max(boxX + 6, Math.min(portraitCenter, boxX + boxW - 6));
    } else {
      // Default: full-width bar at bottom of screen
      boxX = BOX_MARGIN;
      boxW = viewport.width - BOX_MARGIN * 2;
    }

    // Re-wrap at actual box width if it differs from preliminary width
    const availableTextW = boxW - INNER_PAD * 2;
    const finalLines = (availableTextW < prelimAvailW)
      ? wordWrap(this.displayedText, availableTextW, FONT)
      : wrappedLines;

    // Compute Y position (depends on box height)
    // Python formula: pos_y = WINHEIGHT - height - portrait_height(80) - 4
    // This places the dialog above the portrait area at the bottom of screen.
    let boxY: number;
    if (this.portrait) {
      boxY = viewport.height - boxH - 80 - 4;
      // Clamp to at least 2px from top
      if (boxY < 2) boxY = 2;
    } else {
      boxY = viewport.height - boxH - BOX_MARGIN;
    }

    // During transition_in, animate the background growing + fading in
    // Python: background grows from center and opacity increases over 10 frames
    if (isTransitionIn) {
      const alpha = 0.92 * transT;
      const scaleW = 0.5 + 0.5 * transT;
      const scaleH = 0.3 + 0.7 * transT;
      const transBoxW = boxW * scaleW;
      const transBoxH = boxH * scaleH;
      const transBoxX = boxX + (boxW - transBoxW) / 2;
      const transBoxY = boxY + (boxH - transBoxH) / 2;
      surf.fillRect(transBoxX, transBoxY, transBoxW, transBoxH, `rgba(12, 12, 28, ${alpha.toFixed(2)})`);
      surf.drawRect(transBoxX, transBoxY, transBoxW, transBoxH,
        `rgba(160, 160, 200, ${(0.5 * transT).toFixed(2)})`);
      // Don't draw tail, text, or speaker during transition_in (matching Python)
      return;
    }

    // Background
    surf.fillRect(boxX, boxY, boxW, boxH, BG_COLOR);

    // Pixel-art border
    surf.drawRect(boxX, boxY, boxW, boxH, BORDER_COLOR);
    surf.drawRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2, 'rgba(80, 80, 120, 0.3)');

    // Speech bubble tail pointing toward portrait
    if (tailX !== null && this.portrait) {
      const tailBaseY = boxY + boxH;
      // Small triangle tail
      for (let i = 0; i < TAIL_HEIGHT; i++) {
        const tw = TAIL_HEIGHT - i;
        surf.fillRect(tailX - tw, tailBaseY + i, tw * 2, 1, BG_COLOR);
      }
    }

    let textY = boxY + INNER_PAD;
    const textX = boxX + INNER_PAD;

    // Speaker name (yellow)
    if (this.speaker) {
      surf.drawText(this.speaker, textX, textY, SPEAKER_COLOR, SPEAKER_FONT);
      textY += LINE_HEIGHT;
    }

    // Render word-wrapped text lines
    for (const line of finalLines) {
      surf.drawText(line, textX, textY, TEXT_COLOR, FONT);
      textY += LINE_HEIGHT;
    }

    // Waiting indicator — a small blinking triangle
    if (this.state === 'waiting') {
      this.frameCounter++;
      if (Math.floor(this.frameCounter / 20) % 2 === 0) {
        const indicatorX = boxX + boxW - 10;
        const indicatorY = boxY + boxH - 10;
        surf.fillRect(indicatorX, indicatorY, 4, 4, TEXT_COLOR);
      }
    }
  }

  /** Check if done */
  isDone(): boolean {
    return this.state === 'done';
  }

  /** True while the typewriter is actively advancing characters. */
  isTyping(): boolean {
    return this.state === 'typing';
  }

  /** Finish typing the current line instantly. */
  private _finishCurrentLine(): void {
    const currentLineText = this.lines[this.currentLine] ?? '';
    // Strip inline commands for display
    let text = currentLineText.slice(this.charIndex);
    text = text
      .replace(/\{w\}/g, '')
      .replace(/\{br\}/g, '\n')
      .replace(/\{clear\}/g, '')
      .replace(/\{p\}/g, '')
      .replace(/\{max_speed\}/g, '')
      .replace(/\{starting_speed\}/g, '')
      .replace(/\{speed:\d+(?:\.\d+)?\}/g, '')
      .replace(/\{c:[^}]*\}/g, '')
      .replace(/\{[^}]*\}/g, '');
    this.displayedText += text;
    this.charIndex = currentLineText.length;

    if (this.currentLine < this.lines.length - 1) {
      this.state = 'waiting';
      this.waitingForInput = true;
    } else {
      this.state = 'waiting';
      this.waitingForInput = true;
    }
  }

  /** Skip the entire dialog immediately. */
  private _skipAll(): void {
    this.state = 'done';
    this.currentLine = this.lines.length - 1;
    this.charIndex = (this.lines[this.currentLine] ?? '').length;
  }
}
