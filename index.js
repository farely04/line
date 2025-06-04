// api/webhook.js

// 1. โหลด dependency ที่จำเป็น
const { Client, validateSignature } = require("@line/bot-sdk");
const axios = require("axios");

// 2. อ่านค่า Environment Variables (ตั้งไว้บน Vercel Dashboard)
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_SECRET       = process.env.LINE_SECRET;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;

// 3. สร้าง LINE SDK Client สำหรับส่งข้อความตอบกลับ
const lineClient = new Client({
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret:      LINE_SECRET,
});

// 4. ปิด body parser ของ Vercel เพื่อให้เราดักอ่าน raw body ก่อนตรวจ signature
export const config = {
  api: {
    bodyParser: false,
  },
};

// 5. ฟังก์ชันเรียก Google Gemini (ข้อความ)
async function callGeminiAPI(userMessage) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [
        { parts: [{ text: userMessage }] }
      ],
    };

    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
    });

    const aiResponse =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text
      || "ขออภัย ฉันไม่สามารถตอบคำถามนี้ได้";
    return aiResponse;
  } catch (error) {
    console.error("Error calling Gemini API (text):", error.response?.data || error.message);
    return "ขออภัย มีข้อผิดพลาด กรุณาลองใหม่อีกครั้ง";
  }
}

// 6. ฟังก์ชันเรียก Google Gemini (รูปภาพ)
async function callGeminiAPIWithImage(imageBase64) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [
        { parts: [{ text: "โปรดวิเคราะห์รูปภาพนี้" }] },
        { parts: [{ inline_data: { mime_type: "image/jpeg", data: imageBase64 } }] }
      ],
    };

    const response = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
    });

    const aiResponse =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text
      || "ขออภัย ฉันไม่สามารถวิเคราะห์ภาพนี้ได้";
    return aiResponse;
  } catch (error) {
    console.error("Error calling Gemini API (image):", error.response?.data || error.message);
    return "ขออภัย ฉันไม่สามารถวิเคราะห์ภาพนี้ได้ในขณะนี้";
  }
}

// 7. ฟังก์ชันดาวน์โหลดรูปจาก LINE Server แล้วแปลงเป็น Base64
async function getImageFromLine(messageId) {
  try {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
      responseType: "arraybuffer",
    });
    return Buffer.from(response.data, "binary").toString("base64");
  } catch (error) {
    console.error("Error downloading image from LINE:", error.response?.data || error.message);
    return null;
  }
}

// 8. ฟังก์ชันหลัก (handler) ที่ Vercel จะเรียกเมื่อมี POST มาที่ /api/webhook
export default async function handler(req, res) {
  // 8.1 ตรวจ Method ต้องเป็น POST เท่านั้น
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // 8.2 อ่าน raw request body (Buffer) เพื่อใช้ตรวจ signature
  let buf = Buffer.alloc(0);
  for await (const chunk of req) {
    buf = Buffer.concat([buf, chunk]);
  }
  const rawBody  = buf.toString();
  const signature = req.headers["x-line-signature"];

  // 8.3 ตรวจสอบ signature ว่า LINE ส่งมาแท้หรือไม่
  if (!validateSignature(rawBody, LINE_SECRET, signature)) {
    return res.status(401).send("Invalid signature");
  }

  // 8.4 แปลง raw body เป็น JSON
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    console.error("Cannot parse body JSON:", e);
    return res.status(400).send("Bad Request");
  }

  // 8.5 ดึง events ที่ LINE ส่งมา (array)
  const events = body.events || [];

  // 8.6 วนลูปประมวลผลแต่ละ event
  const promises = events.map(async (event) => {
    if (event.type !== "message") {
      // กรณีไม่ใช่ message ก็ข้าม
      return;
    }

    // 8.6.1 ถ้า user ส่งข้อความ (text)
    if (event.message.type === "text") {
      const userMessage = event.message.text;
      const aiResponse  = await callGeminiAPI(userMessage);
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: aiResponse,
      });
    }

    // 8.6.2 ถ้า user ส่งรูปภาพ (image)
    if (event.message.type === "image") {
      const imageBase64 = await getImageFromLine(event.message.id);
      if (!imageBase64) {
        return lineClient.replyMessage(event.replyToken, {
          type: "text",
          text: "ไม่สามารถดาวน์โหลดรูปภาพได้",
        });
      }
      const aiResponse = await callGeminiAPIWithImage(imageBase64);
      return lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: aiResponse,
      });
    }

    // 8.6.3 กรณีอื่นๆ (video, sticker ฯลฯ) ไม่ต้องทำอะไร
    return;
  });

  // 8.7 รอให้ทุก replyMessage เสร็จ แล้วตอบกลับ 200 OK ให้ LINE
  try {
    await Promise.all(promises);
    return res.status(200).send("OK");
  } catch (e) {
    console.error("Error handling events:", e);
    return res.status(500).send("Internal Server Error");
  }
}
