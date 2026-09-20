using System;

namespace Bungohan.Protocol
{
    /// <summary>Protocol-level constants a client needs (PROTOCOL.md §2, §6, §7).</summary>
    public static class BungohanProtocol
    {
        /// <summary>The WebSocket subprotocol this client speaks (§2.1).</summary>
        public const string Version = "bungohan.v1";
    }

    /// <summary>The <c>mode</c> of a <c>JOIN</c> body (PROTOCOL.md §6.2).</summary>
    public static class JoinMode
    {
        public const int JoinOrCreate = 0;
        public const int Create = 1;
        public const int Join = 2;
        public const int JoinById = 3;
        public const int Reconnect = 4;
        public const int ConsumeReservation = 5;
    }

    /// <summary>The <c>code</c> of a <c>LEAVE</c> frame (PROTOCOL.md §7.1).</summary>
    public static class LeaveCode
    {
        public const int Consented = 1000;

        /// <summary>Used locally when a seat can't be resumed.</summary>
        public const int Disconnected = 1001;

        public const int Kicked = 4000;
        public const int ServerShutdown = 4001;
        public const int RoomDisposed = 4002;
    }

    /// <summary>WebSocket close codes this protocol uses (PROTOCOL.md §8.3).</summary>
    public static class CloseCode
    {
        public const int Normal = 1000;
        public const int GoingAway = 1001;

        /// <summary>The server does not speak this protocol version (§2.2).</summary>
        public const int ProtocolError = 1002;

        public const int Abnormal = 1006;
        public const int PolicyViolation = 1008;
        public const int TooLarge = 1009;
    }

    /// <summary>Where a client's connection is.</summary>
    public enum ConnectionState
    {
        Disconnected,
        Connecting,
        Connected,
        Reconnecting,
    }

    /// <summary>Where a room is in its life (spec §7.5).</summary>
    public enum RoomStatus
    {
        /// <summary><c>JOIN_SUCCESS</c> received, waiting for the first snapshot.</summary>
        Joining,

        Joined,

        /// <summary>The connection dropped; the seat is being resumed.</summary>
        Reconnecting,

        Left,
    }

    /// <summary>
    /// Why a client operation failed. The codes are the <c>JOIN_ERROR</c>
    /// codes of PROTOCOL.md §8.1 plus the local ones below.
    /// </summary>
    public sealed class ClientError
    {
        public ClientError(string code, string message, object? context = null)
        {
            Code = code;
            Message = message;
            Context = context;
        }

        public string Code { get; }
        public string Message { get; }

        /// <summary>For an unrecognized server code, the original code.</summary>
        public object? Context { get; }

        public override string ToString() => Code + ": " + Message;
    }

    /// <summary>Every <see cref="ClientError.Code"/> this client produces.</summary>
    public static class ClientErrorCodes
    {
        // JOIN_ERROR codes (PROTOCOL.md §8.1).
        public const string InvalidOptions = "INVALID_OPTIONS";
        public const string ServerShuttingDown = "SERVER_SHUTTING_DOWN";
        public const string RoomTypeNotDefined = "ROOM_TYPE_NOT_DEFINED";
        public const string ContractMismatch = "CONTRACT_MISMATCH";
        public const string RoomNotFound = "ROOM_NOT_FOUND";
        public const string RoomLocked = "ROOM_LOCKED";
        public const string RoomFull = "ROOM_FULL";
        public const string AlreadyJoined = "ALREADY_JOINED";
        public const string AuthFailed = "AUTH_FAILED";
        public const string JoinFailed = "JOIN_FAILED";
        public const string InvalidToken = "INVALID_TOKEN";
        public const string ReservationNotFound = "RESERVATION_NOT_FOUND";
        public const string ReservationExpired = "RESERVATION_EXPIRED";

        // Local codes.
        public const string ConnectionFailed = "CONNECTION_FAILED";
        public const string ConnectionLost = "CONNECTION_LOST";
        public const string ReconnectionFailed = "RECONNECTION_FAILED";
        public const string NotConnected = "NOT_CONNECTED";
        public const string ProtocolError = "PROTOCOL_ERROR";
        public const string CodecMismatch = "CODEC_MISMATCH";
        public const string InvalidMessage = "INVALID_MESSAGE";
        public const string UnknownMessage = "UNKNOWN_MESSAGE";
        public const string NotJoined = "NOT_JOINED";
        public const string Left = "LEFT";
        public const string Timeout = "TIMEOUT";
        public const string Desync = "DESYNC";
        public const string ServerError = "SERVER_ERROR";
        public const string UnknownClass = "UNKNOWN_CLASS";

        private static readonly string[] s_joinErrors =
        {
            InvalidOptions, ServerShuttingDown, RoomTypeNotDefined, ContractMismatch,
            RoomNotFound, RoomLocked, RoomFull, AlreadyJoined, AuthFailed, JoinFailed,
            InvalidToken, ReservationNotFound, ReservationExpired,
        };

        /// <summary>
        /// A <c>JOIN_ERROR</c> code as a client code. One this version
        /// doesn't know (a newer server) becomes <c>JOIN_FAILED</c>, with
        /// the original kept in <see cref="ClientError.Context"/> (§8.1).
        /// </summary>
        public static string FromJoinError(string code)
        {
            foreach (string known in s_joinErrors)
            {
                if (known == code) return code;
            }
            return JoinFailed;
        }
    }

    /// <summary>How the client retries after an unexpected close (§7.3).</summary>
    public sealed class ReconnectionOptions
    {
        public bool Enabled { get; set; } = true;
        public int MaxAttempts { get; set; } = 10;
        public double DelayMs { get; set; } = 1000;
        public double DelayMaxMs { get; set; } = 30000;
        public double Factor { get; set; } = 2;
    }

    /// <summary>
    /// The <c>JOIN_SUCCESS</c> handshake (PROTOCOL.md §6.4). Elements after
    /// the eighth are ignored (§9.1).
    /// </summary>
    public sealed class JoinHandshake
    {
        public JoinHandshake(string roomId, string roomType, string sessionId, string? reconnectionToken,
            string contractHash, string stateCodec, string[] clientMessages, string[] serverMessages)
        {
            RoomId = roomId;
            RoomType = roomType;
            SessionId = sessionId;
            ReconnectionToken = reconnectionToken;
            ContractHash = contractHash;
            StateCodec = stateCodec;
            ClientMessages = clientMessages;
            ServerMessages = serverMessages;
        }

        public string RoomId { get; }
        public string RoomType { get; }
        public string SessionId { get; }
        public string? ReconnectionToken { get; }
        public string ContractHash { get; }
        public string StateCodec { get; }
        public string[] ClientMessages { get; }
        public string[] ServerMessages { get; }

        /// <summary>Reads a decoded handshake body, or null if it is malformed.</summary>
        public static JoinHandshake? Parse(object? body)
        {
            if (!(body is System.Collections.Generic.List<object?> array) || array.Count < 8) return null;
            if (!(array[0] is string roomId) || !(array[1] is string roomType) ||
                !(array[2] is string sessionId) || !(array[4] is string hash) ||
                !(array[5] is string codec))
            {
                return null;
            }
            object? tokenValue = array[3];
            if (tokenValue != null && !(tokenValue is string)) return null;
            string[]? client = Strings(array[6]);
            string[]? server = Strings(array[7]);
            if (client == null || server == null) return null;
            return new JoinHandshake(roomId, roomType, sessionId, tokenValue as string, hash, codec, client, server);
        }

        private static string[]? Strings(object? value)
        {
            if (!(value is System.Collections.Generic.List<object?> list)) return null;
            var result = new string[list.Count];
            for (int i = 0; i < list.Count; i++)
            {
                if (!(list[i] is string text)) return null;
                result[i] = text;
            }
            return result;
        }
    }
}
