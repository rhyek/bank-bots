// YNAB transaction memos written by the (now-retired) update-ynab sync encode the originating bank
// transaction as a `ref`, in one of two historical shapes:
//   - text:  "ref: 20240326_140540; desc: MIPAGO CLARO RECURRENC GT;"  (or a bare "ref: 276226; ...")
//   - json:  {"ref":"20240226_174848","desc":"PedidosYa PROPINAS GT"}
// The ref is either `YYYYMMDD_<docNo>` (optionally with a `(n)` collision suffix) or a bare `<docNo>`.
// Ported from update-ynab's ParseYnabTransactionMemo (Go).

export interface ParsedMemo {
  ref: string;
  desc: string;
}

export function parseYnabMemo(memo: string | null | undefined): ParsedMemo {
  const result: ParsedMemo = { ref: '', desc: '' };
  if (!memo) {
    return result;
  }

  // JSON shape: {"ref":"...","desc":"..."}
  try {
    const parsed: unknown = JSON.parse(memo);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.ref === 'string') {
        result.ref = obj.ref;
      }
      if (typeof obj.desc === 'string') {
        result.desc = obj.desc;
      }
    }
  } catch {
    // not JSON; fall through to the text-shape regexes
  }

  const refMatch = memo.match(/ref: ([\d_()]+);/);
  if (refMatch) {
    result.ref = refMatch[1];
  }
  const descMatch = memo.match(/desc: (.+?);/);
  if (descMatch) {
    result.desc = descMatch[1];
  }

  return result;
}

// Extract the bank document number from a parsed ref: strip any `(n)` collision suffix, then take the
// part after `YYYYMMDD_` (or the whole thing if the ref is a bare doc number). Returns null when the
// ref is empty. Used to match a YNAB tx back to a bank_tx (together with account, date and amount).
export function docNoFromRef(ref: string): string | null {
  if (!ref) {
    return null;
  }
  const core = ref.replace(/\(\d+\)$/, '');
  const dated = core.match(/^\d{8}_(.+)$/);
  return dated ? dated[1] : core;
}
