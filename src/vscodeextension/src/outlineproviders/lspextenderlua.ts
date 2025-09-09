import * as vscode from 'vscode';
import { VpLspExtenderProvider } from '../outlineproviderAPI/lspextenderprovider';
import * as Outline from '../outlineproviderAPI/SymbolDefinition';
import * as utils from '../utils';
import { OutlineUtils } from '../outlineproviderAPI/utils/outlineutils';

/**
 * LspExtenderProvider for Lua
 *
 * Notes:
 *  - Heuristics assume simple `function ...(...) ... end` structure.
 *  - Nested/end matching is naive and may fail with complex scopes.
 */
export class VpLspExtenderLua implements VpLspExtenderProvider {
  public getLanguageStr(): string {
    return 'lua';
  }

  public isDefinition(_doc: vscode.TextDocument, _position: vscode.Position): boolean {
    // TODO: Differentiate definition vs. reference. Keep simple for now.
    return false;
  }

  /**
   * Determine head/body ranges for a DocumentSymbol using Lua syntax cues.
   * Returns: [rangeHead, rangeBody, attributes]
   */
  public getLanguageSpecificSymbolInformation(
    document: vscode.TextDocument,
    docSymbol: vscode.DocumentSymbol
  ): any[] {
    const END_KEYWORD = 'end';
    const PAREN_O = '(';
    const PAREN_C = ')';

    let rangeHead: vscode.Range | null = null;
    let rangeBody: vscode.Range | null = null;
    const attributes: Outline.Attribute[] = [];

    // Find head range: from name start to closing paren of parameter list
    {
      const name_start = [docSymbol.selectionRange.start.line, docSymbol.selectionRange.start.character];
      const name_end = [docSymbol.selectionRange.end.line, docSymbol.selectionRange.end.character];

      const head_start_line = name_start[0];
      const head_start_char = name_start[1];

      let headEnd: number[] | null = null;
      const parenLoc = utils.findInDocument(PAREN_O, document, name_end);
      if (parenLoc) {
        const parenEnd = utils.findInDocument(PAREN_C, document, parenLoc);
        if (parenEnd) {
          headEnd = parenEnd;
        }
      }

      if (!headEnd) throw new Error('Error: Function not parsable (Could not find head range).');

      rangeHead = utils.range_new(head_start_line, head_start_char, headEnd[0], headEnd[1]);
    }

    // Find body range: from right after head to the matching `end`
    {
      if (!rangeHead) throw new Error('Error: Function not parsable (rangeHead is null).');

      let body_start_line = rangeHead.end.line;
      let body_start_char = rangeHead.end.character + 1; // skip closing paren

      // Find the 'end' keyword that closes this function
      const endLoc = utils.findInDocument(END_KEYWORD, document, [body_start_line, body_start_char]);
      if (!endLoc) throw new Error('Error: Function not parsable (Could not find end keyword).');

      const body_end_line = endLoc[0];
      const body_end_char = endLoc[1] + END_KEYWORD.length;

      // Adjust body start if remainder of the line is whitespace
      {
        const line = document.lineAt(body_start_line).text.substr(body_start_char);
        if (line.trim() === '') {
          body_start_line++;
          body_start_char = 0;
        }
      }

      rangeBody = utils.range_new(body_start_line, body_start_char, body_end_line, body_end_char);
    }

    return [rangeHead, rangeBody, attributes];
  }

  public async provideOutlineForRange(
    document: vscode.TextDocument,
    symbolRange: vscode.Range
  ): Promise<Array<Outline.Symbol | Outline.Text>> {
    const ret: Array<Outline.Symbol | Outline.Text> = [];
    // Placeholder for future implementation
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const symbolsInRange = OutlineUtils.getDocumentSymbolsInRange(document.uri, symbolRange);
    throw new Error('outlines for ranges are not yet implemented');
    // return ret; // unreachable until implemented
  }
}
