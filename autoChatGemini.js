require("dotenv").config();
const axios = require("axios");
const WebSocket = require("ws");

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;

// Constants
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_API = "https://discord.com/api/v9"; // Using v9 for user accounts
const GEMINI_MODEL = "gemini-2.0-flash"; // Sử dụng mô hình Gemini 2.0 Flash
const GEMINI_API_VERSION = "v1"; // Sử dụng API v1 (không phải v1beta)
const MAX_RESPONSE_LENGTH = 50; // Giới hạn độ dài phản hồi (ký tự)

// Global variables
let ws;
let heartbeatInterval;
let sequence = null;
let sessionId = null;
let reconnectAttempts = 0;
let userId = null;

// Biến theo dõi trạng thái phản hồi
let isProcessingReply = false;
let respondedUserIds = new Set(); // Lưu trữ ID người dùng đã phản hồi

// Danh sách những câu trả lời ngắn gọn
const SHORT_RESPONSES = [
  "Cào mạnh lên nào ae^^",
  "Em newbie mọi ngừi ưiiii",
  "Hihi mọi người cute quá",
  "Anh em nghĩ sao????",
  "Không gì là không thể!!!",
  "Tôi sẽ cào mạnh hơn nữa",
  "Đúng vậy rồi!!",
  "Hôm nay trời đẹp quá!",
  "Hay quá anh em ơi",
  "Suy nghĩ kỹ đi nào",
  "Ra là vậy à??",
  "Đúng rồi đó",
  "Thú vị ghê",
  "Nói hay quá",
  "Quá đỉnh luôn",
  "Anh em có ai giống em không",
  "Có vẻ hợp lý đấy",
  "Cứ phải thế chứ",
  "Ối trời ơi",
  "Mê quá đi",
  "Mình hiểu rồi",
  "Nghe hay phết",
  "Hóng phần sau",
  "Xinh quá trời à",
  "Cảm ơn anh em nhiều!",
  "Cao thủ thật sự",
  "Quá ghê gớm",
  "Oke oke",
  "Cái này hay nè",
  "Đúng chuẩn luôn",
];

// Chọn phương pháp phản hồi (1 = Gemini ngắn gọn, 2 = Chỉ câu ngẫu nhiên)
const RESPONSE_METHOD = 2; // Thay đổi thành 1 nếu muốn dùng Gemini với phản hồi ngắn

// Initialize connection
function connect() {
  ws = new WebSocket(DISCORD_GATEWAY);
  setupWebSocket();
}

// Setup WebSocket event handlers
function setupWebSocket() {
  ws.on("open", () => {
    console.log("✅ Kết nối Discord thành công!");
    reconnectAttempts = 0;
  });

  ws.on("message", async (data) => {
    const payload = JSON.parse(data);

    // Save sequence for heartbeats
    if (payload.s) sequence = payload.s;

    switch (payload.op) {
      // Hello event
      case 10:
        const { heartbeat_interval } = payload.d;
        handleHello(heartbeat_interval);
        break;

      // Heartbeat ACK
      case 11:
        // Heartbeat acknowledged
        break;

      // Dispatch events
      case 0:
        handleDispatch(payload);
        break;

      // Invalid session
      case 9:
        console.log("⚠️ Phiên không hợp lệ, đang kết nối lại...");
        setTimeout(() => {
          identify();
        }, 5000);
        break;

      // Reconnect request
      case 7:
        console.log("⚠️ Yêu cầu kết nối lại từ Discord...");
        reconnect();
        break;
    }
  });

  ws.on("close", (code) => {
    console.log(`⚠️ WebSocket đã đóng với mã: ${code}`);
    clearInterval(heartbeatInterval);

    // Implement exponential backoff for reconnection
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
    reconnectAttempts++;

    console.log(`⏱️ Đang thử kết nối lại sau ${delay / 1000} giây...`);
    setTimeout(reconnect, delay);
  });

  ws.on("error", (error) => {
    console.error("❌ Lỗi WebSocket:", error.message);
  });
}

// Handle Hello event
function handleHello(interval) {
  console.log(`🔄 Đã nhận Hello, thiết lập heartbeat mỗi ${interval}ms`);

  // Clear any existing interval
  if (heartbeatInterval) clearInterval(heartbeatInterval);

  // Setup heartbeat
  heartbeatInterval = setInterval(() => {
    ws.send(JSON.stringify({ op: 1, d: sequence }));
    console.log("💓 Đã gửi heartbeat");
  }, interval);

  // Identify with Discord
  identify();
}

// Identify with Discord - for user account (self-bot)
function identify() {
  // Clean the token (remove 'Bearer ' if present)
  let cleanToken = token;
  if (cleanToken.startsWith("Bearer ")) {
    cleanToken = cleanToken.substring(7);
  }

  const identifyPayload = {
    op: 2,
    d: {
      token: cleanToken,
      intents: 32767,
      properties: {
        os: "Windows",
        browser: "Chrome",
        device: "",
        browser_user_agent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        browser_version: "120.0.0.0",
        os_version: "10",
        referrer: "https://discord.com",
        referring_domain: "discord.com",
        referrer_current: "",
        referring_domain_current: "",
        release_channel: "stable",
        client_build_number: 245335,
        client_event_source: null,
      },
      presence: {
        status: "online",
        since: 0,
        activities: [],
        afk: false,
      },
      compress: false,
      client_state: {
        guild_versions: {},
        highest_last_message_id: "0",
        read_state_version: 0,
        user_guild_settings_version: -1,
        user_settings_version: -1,
        private_channels_version: "0",
        api_code_version: 0,
      },
    },
  };

  ws.send(JSON.stringify(identifyPayload));
  console.log("🔑 Đã gửi thông tin xác thực");
}

// Handle Dispatch events
function handleDispatch(payload) {
  const { t: eventType, d: data } = payload;

  switch (eventType) {
    case "READY":
      sessionId = data.session_id;
      userId = data.user.id;
      console.log(
        `🤖 User đã sẵn sàng! ID: ${userId}, Tên: ${data.user.username}`
      );
      break;

    case "MESSAGE_CREATE":
      handleMessage(data);
      break;
  }
}

// Xử lý tin nhắn đến
async function handleMessage(message) {
  // Bỏ qua tin nhắn của mình
  if (message.author.id === userId) return;

  // Bỏ qua tin nhắn từ các kênh khác
  if (message.channel_id !== channelId) return;

  // Log tin nhắn nhận được
  console.log(
    `📩 Tin nhắn từ ${message.author.username} (${message.author.id}): ${message.content}`
  );

  // Kiểm tra nếu đang xử lý tin nhắn khác, bỏ qua
  if (isProcessingReply) {
    console.log(
      `⏳ Đang xử lý tin nhắn khác, bỏ qua tin nhắn từ ${message.author.username}`
    );
    return;
  }

  // Kiểm tra nếu đã trả lời người dùng này trước đó, bỏ qua
  if (respondedUserIds.has(message.author.id)) {
    console.log(
      `ℹ️ Đã trả lời ${message.author.username} trước đó, bỏ qua để tránh spam`
    );
    return;
  }

  try {
    // Đánh dấu đang xử lý
    isProcessingReply = true;

    // Bắt đầu hiển thị đang nhập
    await sendTypingIndicator();

    // Lấy phản hồi
    let reply;

    if (RESPONSE_METHOD === 1) {
      // Phương pháp 1: Sử dụng Gemini với phản hồi ngắn
      try {
        reply = await getShortGeminiResponse(message.content);
      } catch (error) {
        console.error("❌ Lỗi khi lấy phản hồi từ Gemini:", error.message);
        // Phản hồi cố định nếu tất cả đều thất bại
        reply = getRandomShortResponse();
      }
    } else {
      // Phương pháp 2: Chỉ sử dụng câu ngẫu nhiên
      reply = getRandomShortResponse();
    }

    // Gửi phản hồi với hiệu ứng đang nhập
    await sendMessageWithTypingEffect(reply, message.id);

    // Thêm người dùng vào danh sách đã phản hồi
    respondedUserIds.add(message.author.id);
    console.log(
      `✅ Đã thêm ${message.author.username} vào danh sách đã phản hồi`
    );

    // Đợi một thời gian trước khi cho phép phản hồi tiếp
    setTimeout(() => {
      isProcessingReply = false;
      console.log("✅ Sẵn sàng phản hồi tin nhắn mới");
    }, 10000); // 10 giây
  } catch (error) {
    console.error("❌ Lỗi khi xử lý tin nhắn:", error.message);
    isProcessingReply = false;
  }
}

// Định kỳ làm mới danh sách người dùng đã phản hồi
setInterval(() => {
  if (respondedUserIds.size > 0) {
    console.log(
      `🔄 Đang làm mới danh sách người dùng đã phản hồi (${respondedUserIds.size} người dùng)`
    );
    respondedUserIds.clear();
  }
}, 60 * 60 * 1000); // Làm mới sau 1 giờ

// Reconnect to Discord
function reconnect() {
  console.log("🔄 Đang kết nối lại...");

  // Clear existing interval
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Close existing connection
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.close();
  }

  // Reconnect
  connect();
}

// Send typing indicator for user account
async function sendTypingIndicator() {
  try {
    await axios.post(
      `${DISCORD_API}/channels/${channelId}/typing`,
      {},
      { headers: { Authorization: token } }
    );
  } catch (error) {
    console.error("❌ Lỗi khi gửi trạng thái đang nhập:", error.message);

    // Log detailed error for debugging
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data:`, error.response.data);
    }
  }
}

// Get short response from Gemini AI
async function getShortGeminiResponse(message) {
  console.log(
    `🤖 Đang gửi yêu cầu đến Gemini: "${message.substring(0, 50)}${
      message.length > 50 ? "..." : ""
    }"`
  );

  try {
    console.log(
      `📡 Đang gửi yêu cầu đến ${GEMINI_MODEL} (${GEMINI_API_VERSION})`
    );

    // Chuẩn bị dữ liệu yêu cầu với prompt yêu cầu phản hồi ngắn gọn
    const requestData = {
      contents: [
        {
          parts: [
            {
              text: `Phản hồi câu nói này một cách ngắn gọn, vui vẻ, thân thiện, không quá 20 từ, phong cách của một người dùng mạng xã hội: "${message}"`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.9, // Tăng temperature để có câu trả lời đa dạng hơn
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 30, // Giới hạn token đầu ra
      },
    };

    // Gửi yêu cầu đến Gemini API
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
      requestData,
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000, // 30 giây timeout
      }
    );

    // Xử lý phản hồi
    let reply = "";

    if (response.data.candidates && response.data.candidates.length > 0) {
      const candidate = response.data.candidates[0];

      if (
        candidate.content &&
        candidate.content.parts &&
        candidate.content.parts.length > 0
      ) {
        reply = candidate.content.parts[0].text;
      }
    }

    if (reply) {
      // Cắt bớt phản hồi quá dài và loại bỏ dấu ngoặc kép nếu có
      reply = reply.replace(/"/g, "").trim();
      if (reply.length > MAX_RESPONSE_LENGTH) {
        reply = reply.substring(0, MAX_RESPONSE_LENGTH) + "...";
      }

      console.log(`📝 Nhận được phản hồi từ Gemini: "${reply}"`);
      return reply;
    } else {
      console.warn(
        "⚠️ Không thể trích xuất phản hồi từ dữ liệu:",
        JSON.stringify(response.data).substring(0, 200)
      );
      return getRandomShortResponse();
    }
  } catch (error) {
    console.error(`❌ Lỗi với ${GEMINI_MODEL}:`, error.message);
    throw error;
  }
}

// Lấy câu trả lời ngắn gọn ngẫu nhiên
function getRandomShortResponse() {
  const index = Math.floor(Math.random() * SHORT_RESPONSES.length);
  return SHORT_RESPONSES[index];
}

// Check channel's slow mode setting
async function checkSlowMode() {
  try {
    const response = await axios.get(`${DISCORD_API}/channels/${channelId}`, {
      headers: { Authorization: token },
    });

    return response.data.rate_limit_per_user || 0;
  } catch (error) {
    console.error(
      "❌ Lỗi khi kiểm tra Slow Mode:",
      error.response?.data || error.message
    );
    return 0;
  }
}

// Simulate typing before sending message
async function sendMessageWithTypingEffect(content, replyToId) {
  if (!content || content.trim() === "") {
    console.log("⚠️ Không gửi tin nhắn trống");
    return;
  }

  // Giảm thời gian typing delay vì câu ngắn gọn
  const typingDelay = Math.min(5000, Math.max(1000, content.length * 100));

  console.log(`⌨️ Đang nhập tin nhắn... (${(typingDelay / 1000).toFixed(1)}s)`);

  // Keep sending typing indicators while "typing"
  let typingStartTime = Date.now();

  // Send first typing indicator
  await sendTypingIndicator();

  // Set up interval to keep sending typing indicators
  const typingInterval = setInterval(async () => {
    if (Date.now() - typingStartTime < typingDelay) {
      await sendTypingIndicator();
    } else {
      clearInterval(typingInterval);
    }
  }, 5000); // Discord typing indicator lasts 10 seconds, refresh every 5s

  // Wait for the calculated typing delay
  await new Promise((resolve) => setTimeout(resolve, typingDelay));

  // Clear typing indicator interval
  clearInterval(typingInterval);

  // Finally send the message
  await sendMessage(content, replyToId);
}

// Send message to Discord - with reply functionality
async function sendMessage(content, replyToId) {
  if (!content || content.trim() === "") return;

  try {
    // Check for slow mode
    const slowMode = await checkSlowMode();
    if (slowMode > 0) {
      console.log(`⏳ Slow Mode: Chờ ${slowMode} giây trước khi gửi tin.`);
      await new Promise((resolve) => setTimeout(resolve, slowMode * 1000));
    }

    // Log what we're about to send
    console.log(
      `📤 Đang gửi tin nhắn${replyToId ? " (trả lời)" : ""}: ${content}`
    );

    // Prepare message data with reply if needed
    const messageData = {
      content: content,
      tts: false,
    };

    // Add reply data if replying to a message
    if (replyToId) {
      messageData.message_reference = {
        message_id: replyToId,
        channel_id: channelId,
      };
      // Set allowed mentions to ping the replied user by default
      messageData.allowed_mentions = {
        parse: ["users"],
      };
    }

    // Send message to Discord (as user, not bot)
    const response = await axios.post(
      `${DISCORD_API}/channels/${channelId}/messages`,
      messageData,
      { headers: { Authorization: token } }
    );

    console.log(`✅ Đã gửi tin nhắn, ID: ${response.data.id}`);
  } catch (error) {
    // Full error logging for debugging
    console.error("❌ Chi tiết lỗi khi gửi tin nhắn:");
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data:`, error.response.data);

      if (error.response.status === 403) {
        console.log("⛔ Tài khoản bị timeout hoặc không có quyền gửi tin.");
      } else if (error.response.status === 429) {
        const retryAfter = error.response.data.retry_after || 5;
        console.log(`⏳ Rate limit! Thử lại sau ${retryAfter} giây.`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        await sendMessage(content, replyToId); // Try again after waiting
      } else if (error.response.status === 401) {
        console.error("❌ Lỗi xác thực: Token không hợp lệ hoặc đã hết hạn");
      }
    } else if (error.request) {
      console.error("Không nhận được phản hồi từ server Discord");
    } else {
      console.error("Lỗi", error.message);
    }
  }
}

// Start the bot
console.log("🚀 Khởi động Discord self-bot...");
connect();

// Handle process termination
process.on("SIGINT", () => {
  console.log("👋 Đang tắt bot...");
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (ws) ws.close();
  process.exit(0);
});
