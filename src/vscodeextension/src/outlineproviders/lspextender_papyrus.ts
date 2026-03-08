import * as vscode from 'vscode';
import {VpLspExtenderProvider} from '../outlineproviderAPI/lspextenderprovider';
import * as Outline from '../outlineproviderAPI/SymbolDefinition';


/**
 * Minimal LSP extender for Skyrim Papyrus script files (.psc).
 *
 * Papyrus uses keywords like `Function ... EndFunction` and
 * `Event ... EndEvent` instead of curly braces, so we only
 * provide a very simple fallback implementation that keeps
 * the entire symbol range intact.  This allows the outline
 * feature to work without throwing errors for unsupported
 * languages while still letting the LSP provide symbol names.
 */
export class VpLspExtenderPapyrus implements VpLspExtenderProvider {
  public getLanguageStr(): string {
    return 'papyrus';
  }

  public isDefinition(doc: vscode.TextDocument,
                      position: vscode.Position): boolean
  {
    const line = doc.lineAt(position.line).text.trim().toLowerCase();
    return (
      line.startsWith('function') ||
      line.startsWith('event') ||
      line.startsWith('scriptname') ||
      line.startsWith('property')
    );
  }

  public getLanguageSpecificSymbolInformation(
    document: vscode.TextDocument,
    docSymbol: vscode.DocumentSymbol)
      : any[]
  {
    // simple fallback: use LSP-provided selection range as head and
    // the full symbol range as the body.  Attributes are empty.
    return [docSymbol.selectionRange, docSymbol.range, []];
  }

  public async provideOutlineForRange(
                document: vscode.TextDocument,
                range: vscode.Range)
              : Promise<Array<Outline.Symbol | Outline.Text>>
  {
    // simple parser that creates symbols for each Function/Event block
    const lines = document.getText(range).split(/\r?\n/);
    const results: Array<Outline.Symbol | Outline.Text> = [];
    let idx = 0;
    while (idx < lines.length) {
      const line = lines[idx];
      const funcMatch = line.match(/^\s*(Function|Event)\s+([A-Za-z0-9_]+)/i);
      if (funcMatch) {
        const kindWord = funcMatch[1].toLowerCase();
        const name = funcMatch[2];
        const startLine = range.start.line + idx;
        const startChar = line.search(/\S/) >= 0 ? line.search(/\S/) : 0;
        // search for corresponding end
        let endLine = startLine;
        let endChar = lines[idx].length;
        for (let j = idx + 1; j < lines.length; ++j) {
          const endMatch = lines[j].match(/^\s*End(Function|Event)/i);
          if (endMatch) {
            endLine = range.start.line + j;
            endChar = lines[j].length;
            idx = j; // advance outer loop
            break;
          }
        }
        const symbol = new Outline.Symbol();
        symbol.language = 'papyrus';
        symbol.kind = kindWord === 'event' ? 'event' : 'function';
        symbol.uri = document.uri.toString();
        symbol.displayTextRange = new vscode.Range(startLine, startChar, startLine, line.length);
        symbol.totalRange = new vscode.Range(startLine, startChar, endLine, endChar);
        symbol.parts = [];
        results.push(symbol);
      }
      idx++;
    }
    return results;
  }
}
