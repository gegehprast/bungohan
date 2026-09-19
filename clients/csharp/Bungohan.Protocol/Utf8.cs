using System.Text;

namespace Bungohan.Protocol
{
    /// <summary>
    /// Strict UTF-8 (PROTOCOL.md §1.3). Decoding rejects overlong forms,
    /// encoded surrogates, truncated sequences and code points above
    /// U+10FFFF, like a "fatal" decoder; it never substitutes U+FFFD.
    /// Encoding writes a lone UTF-16 surrogate and U+0000 as U+FFFD
    /// (<c>ef bf bd</c>), so every client decodes the same value, whatever
    /// its engine's strings can hold.
    /// </summary>
    public static class Utf8
    {
        // No BOM; the encoder's replacement fallback turns lone surrogates
        // into U+FFFD. Decoding only runs on validated bytes.
        private static readonly UTF8Encoding s_encoding = new UTF8Encoding(false, false);

        public static byte[] Encode(string value) =>
            s_encoding.GetBytes(value.IndexOf('\0') < 0 ? value : value.Replace('\0', '\uFFFD'));

        /// <summary>The decoded string, or null if the bytes aren't valid UTF-8.</summary>
        public static string? Decode(byte[] bytes, int offset, int count)
        {
            if (!IsValid(bytes, offset, count)) return null;
            return s_encoding.GetString(bytes, offset, count);
        }

        /// <summary>True if the range is well-formed UTF-8 (Unicode Table 3-7).</summary>
        public static bool IsValid(byte[] bytes, int offset, int count)
        {
            int i = offset;
            int end = offset + count;
            while (i < end)
            {
                byte b = bytes[i];
                if (b < 0x80)
                {
                    i++;
                    continue;
                }
                int need;
                byte lo = 0x80, hi = 0xbf; // range of the second byte
                if (b >= 0xc2 && b <= 0xdf) need = 1;
                else if (b == 0xe0) { need = 2; lo = 0xa0; }
                else if (b >= 0xe1 && b <= 0xec) need = 2;
                else if (b == 0xed) { need = 2; hi = 0x9f; }
                else if (b >= 0xee && b <= 0xef) need = 2;
                else if (b == 0xf0) { need = 3; lo = 0x90; }
                else if (b >= 0xf1 && b <= 0xf3) need = 3;
                else if (b == 0xf4) { need = 3; hi = 0x8f; }
                else return false;
                if (end - i <= need) return false;
                byte second = bytes[i + 1];
                if (second < lo || second > hi) return false;
                for (int k = 2; k <= need; k++)
                {
                    byte next = bytes[i + k];
                    if (next < 0x80 || next > 0xbf) return false;
                }
                i += need + 1;
            }
            return true;
        }
    }
}
