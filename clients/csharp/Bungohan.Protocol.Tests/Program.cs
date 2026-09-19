using System;
using System.Collections.Generic;

namespace Bungohan.Protocol.Tests
{
    public static class Program
    {
        /// <summary>
        /// Runs every suite and exits non-zero on any failure. Pass suite
        /// names (<c>vectors</c>, <c>replica</c>, <c>bindings</c>) to run only those.
        /// </summary>
        public static int Main(string[] args)
        {
            string root = Values.RepoRoot();
            var wanted = new HashSet<string>(args);
            var suites = new List<Suite>();
            if (wanted.Count == 0 || wanted.Contains("vectors")) suites.Add(VectorRunner.Run(root));
            if (wanted.Count == 0 || wanted.Contains("replica")) suites.Add(ReplicaTests.Run());
            if (wanted.Count == 0 || wanted.Contains("bindings")) suites.Add(BindingsTests.Run(root));

            int failed = 0;
            foreach (Suite suite in suites)
            {
                Console.WriteLine(suite.Name + ": " + suite.Passed + " passed, " + suite.Failures.Count + " failed" +
                                  (suite.Skipped > 0 ? ", " + suite.Skipped + " skipped (behavior: needs a connection)" : ""));
                foreach (string failure in suite.Failures) Console.WriteLine("  FAIL " + failure);
                failed += suite.Failures.Count;
            }
            return failed == 0 ? 0 : 1;
        }
    }
}
