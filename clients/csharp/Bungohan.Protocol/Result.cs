using System;

namespace Bungohan.Protocol
{
    /// <summary>
    /// Why an operation failed. Codes: <c>ENCODE_FAILED</c>,
    /// <c>DECODE_FAILED</c> (codecs, frames, MessagePack), and the replica's
    /// <c>MALFORMED_OP</c>, <c>UNKNOWN_REF</c>, <c>UNKNOWN_CLASS</c>,
    /// <c>SCHEMA_MISMATCH</c> and <c>NO_SNAPSHOT</c> (PROTOCOL.md §11.10).
    /// </summary>
    public sealed class ProtocolError
    {
        public ProtocolError(string code, string message)
        {
            Code = code;
            Message = message;
        }

        public string Code { get; }
        public string Message { get; }

        public override string ToString() => Code + ": " + Message;
    }

    /// <summary>
    /// The outcome of an operation that can fail. Nothing in the protocol
    /// core throws on bad input; it returns one of these instead.
    /// </summary>
    public readonly struct Result<T>
    {
        private readonly T _value;

        private Result(T value, ProtocolError? error)
        {
            _value = value;
            Error = error;
        }

        public bool IsOk => Error == null;
        public ProtocolError? Error { get; }

        /// <summary>The value; throws if this is an error (a caller bug).</summary>
        public T Value
        {
            get
            {
                if (Error != null)
                {
                    throw new InvalidOperationException("Result is an error: " + Error);
                }
                return _value;
            }
        }

        public static Result<T> Ok(T value) => new Result<T>(value, null);

        public static Result<T> Fail(ProtocolError error) => new Result<T>(default!, error);

        public static Result<T> Fail(string code, string message) =>
            new Result<T>(default!, new ProtocolError(code, message));

        public bool TryGet(out T value)
        {
            value = _value;
            return Error == null;
        }

        public override string ToString() => IsOk ? "Ok(" + _value + ")" : "Fail(" + Error + ")";
    }

    /// <summary>A <see cref="Result{T}"/> with no value.</summary>
    public readonly struct Result
    {
        private Result(ProtocolError? error)
        {
            Error = error;
        }

        public bool IsOk => Error == null;
        public ProtocolError? Error { get; }

        public static Result Ok() => new Result(null);

        public static Result Fail(ProtocolError error) => new Result(error);

        public static Result Fail(string code, string message) =>
            new Result(new ProtocolError(code, message));

        public override string ToString() => IsOk ? "Ok" : "Fail(" + Error + ")";
    }

    /// <summary>Error codes used across the protocol core.</summary>
    public static class ErrorCodes
    {
        public const string EncodeFailed = "ENCODE_FAILED";
        public const string DecodeFailed = "DECODE_FAILED";
        public const string MalformedOp = "MALFORMED_OP";
        public const string UnknownRef = "UNKNOWN_REF";
        public const string UnknownClass = "UNKNOWN_CLASS";
        public const string SchemaMismatch = "SCHEMA_MISMATCH";
        public const string NoSnapshot = "NO_SNAPSHOT";
    }
}
