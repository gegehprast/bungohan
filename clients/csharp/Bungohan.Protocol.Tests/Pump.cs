using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Bungohan.Protocol;

namespace Bungohan.Protocol.Tests
{
    /// <summary>
    /// Drives a client the way a game loop would. Every callback and every
    /// task of <see cref="BungohanClient"/> completes inside
    /// <see cref="BungohanClient.Poll"/>, so a test that awaits one has to
    /// keep polling; these helpers are that loop.
    /// </summary>
    public static class Pump
    {
        /// <summary>Polls until <paramref name="task"/> completes, or fails the case.</summary>
        public static T Wait<T>(BungohanClient client, Task<T> task, string what,
            ScriptedTransport? scripted = null, int timeoutMs = 10000)
        {
            Until(client, () => task.IsCompleted, what, scripted, timeoutMs);
            return task.GetAwaiter().GetResult();
        }

        /// <summary>Polls until <paramref name="done"/> holds, or fails the case.</summary>
        public static void Until(BungohanClient client, Func<bool> done, string what,
            ScriptedTransport? scripted = null, int timeoutMs = 10000)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (true)
            {
                scripted?.Flush();
                client.Poll();
                if (done()) return;
                if (DateTime.UtcNow > deadline) throw new CheckFailed("timed out waiting for " + what);
                Thread.Sleep(1);
            }
        }

        /// <summary>Polls for a while, so anything in flight can arrive.</summary>
        public static void For(BungohanClient client, int milliseconds, ScriptedTransport? scripted = null)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            while (DateTime.UtcNow < deadline)
            {
                scripted?.Flush();
                client.Poll();
                Thread.Sleep(1);
            }
            scripted?.Flush();
            client.Poll();
        }

        /// <summary>Collects everything a client logs, for assertions.</summary>
        public static Action<string, string> Collect(List<string> into) =>
            (level, message) => into.Add(level + ": " + message);
    }
}
