// Offline fixtures only. Compile with helper.cs and its vendor source, using
// /main:NativeChromeTcpFixtures. This entry point never calls a Windows API,
// opens a socket, or observes/changes a real browser.
using System;
using System.Collections.Generic;

internal static class NativeChromeTcpFixtures
{
    static int assertions;
    static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
    static void Reject(Action work, string message)
    {
        bool rejected = false;
        try { work(); } catch (Exception) { rejected = true; }
        Check(rejected, message);
    }
    static void U32(byte[] target, int at, uint value) { Array.Copy(BitConverter.GetBytes(value), 0, target, at, 4); }
    static byte[] Row(uint family, byte[] address, int port, uint pid, uint state, uint scope)
    {
        byte[] row = new byte[family == 2 ? 24 : 56];
        Array.Copy(address, 0, row, family == 2 ? 4 : 0, address.Length);
        int p = family == 2 ? 8 : 20;
        row[p] = (byte)(port >> 8); row[p + 1] = (byte)port;
        U32(row, family == 2 ? 0 : 48, state);
        U32(row, family == 2 ? 20 : 52, pid);
        if (family == 23) U32(row, 16, scope);
        return row;
    }
    static byte[] Table(params byte[][] rows)
    {
        int size = 4;
        foreach (byte[] row in rows) size += row.Length;
        byte[] table = new byte[size]; U32(table, 0, (uint)rows.Length);
        int at = 4;
        foreach (byte[] row in rows) { Array.Copy(row, 0, table, at, row.Length); at += row.Length; }
        return table;
    }
    static List<NativeChromeTcp.Listener> Many(uint family, int count)
    {
        byte[] address = new byte[family == 2 ? 4 : 16];
        if (family == 2) { address[0] = 127; address[3] = 1; } else address[15] = 1;
        byte[][] rows = new byte[count][];
        for (int i = 0; i < count; i++) rows[i] = Row(family, address, 9000 + i, 82, 2, 0);
        return NativeChromeTcp.Parse(Table(rows), family, 82);
    }
    static int Main()
    {
        byte[] localhost4 = { 127, 0, 0, 1 }, localhost6 = new byte[16]; localhost6[15] = 1;
        byte[] mapped6 = new byte[16]; mapped6[10] = 255; mapped6[11] = 255; mapped6[12] = 127; mapped6[15] = 1;
        byte[] remote6 = (byte[])localhost6.Clone(); remote6[0] = 32;
        List<NativeChromeTcp.Listener> v4 = NativeChromeTcp.Parse(Table(
            Row(2, localhost4, 9222, 82, 2, 0), Row(2, localhost4, 9222, 82, 2, 0),
            Row(2, localhost4, 9333, 83, 2, 0), Row(2, localhost4, 9444, 82, 5, 0),
            Row(2, new byte[] { 0, 0, 0, 0 }, 9555, 82, 2, 0),
            Row(2, new byte[] { 192, 168, 1, 1 }, 9666, 82, 2, 0),
            Row(2, new byte[] { 127, 0, 0, 2 }, 9777, 82, 2, 0), Row(2, localhost4, 0, 82, 2, 0),
            Row(2, localhost4, 65535, 82, 2, 0)), 2, 82);
        Check(v4.Count == 2, "IPv4 accepts only exact-owner LISTEN localhost rows and deduplicates");
        Check(v4[0].address == "127.0.0.1" && v4[0].port == 9222 && v4[1].port == 65535, "IPv4 network-order ports");
        List<NativeChromeTcp.Listener> v6 = NativeChromeTcp.Parse(Table(
            Row(23, localhost6, 9222, 82, 2, 0), Row(23, localhost6, 9222, 82, 2, 0),
            Row(23, localhost6, 1024, 83, 2, 0), Row(23, localhost6, 1025, 82, 5, 0),
            Row(23, new byte[16], 1026, 82, 2, 0), Row(23, remote6, 1027, 82, 2, 0),
            Row(23, mapped6, 1028, 82, 2, 0), Row(23, localhost6, 1029, 82, 2, 1),
            Row(23, localhost6, 0, 82, 2, 0), Row(23, localhost6, 65535, 82, 2, 0)), 23, 82);
        Check(v6.Count == 2, "IPv6 excludes wildcard/remote/mapped/scoped/other-owner/non-listener rows");
        Check(v6[0].address == "::1" && v6[0].port == 9222 && v6[1].port == 65535, "IPv6 network-order ports");
        Check(NativeChromeTcp.Parse(Table(), 2, 82).Count == 0, "Empty listener table is valid");
        Check(NativeChromeTcp.Merge(v4, v6).Count == 4, "Keep the address family for each exact listener");
        Check(NativeChromeTcp.Merge(v4, v4).Count == 2, "Cross-table duplicates remain bounded");
        Check(Many(2, 32).Count == 32, "Maximum bounded listener count is accepted");
        Reject(delegate { Many(2, 33); }, "Overflow cannot silently omit listeners");
        Reject(delegate { NativeChromeTcp.Merge(Many(2, 17), Many(23, 16)); }, "Combined-family overflow is rejected");
        Reject(delegate { NativeChromeTcp.Parse(null, 2, 82); }, "Missing table is rejected");
        Reject(delegate { NativeChromeTcp.Parse(new byte[3], 2, 82); }, "Missing count is rejected");
        Reject(delegate { NativeChromeTcp.Parse(new byte[4 * 1024 * 1024 + 1], 2, 82); }, "Allocation bound is enforced");
        byte[] truncated = new byte[4]; U32(truncated, 0, 1);
        Reject(delegate { NativeChromeTcp.Parse(truncated, 2, 82); }, "Truncated row is rejected");
        byte[] overflow = new byte[4]; U32(overflow, 0, uint.MaxValue);
        Reject(delegate { NativeChromeTcp.Parse(overflow, 23, 82); }, "Count arithmetic cannot overflow");
        Reject(delegate { NativeChromeTcp.Parse(Table(), 2, 0); }, "Unspecified PID is rejected");
        Reject(delegate { NativeChromeTcp.Parse(Table(), 0, 82); }, "Unspecified address family is rejected");
        Console.WriteLine("Native TCP fixtures: " + assertions + " assertions passed; synthetic data only.");
        return 0;
    }
}
