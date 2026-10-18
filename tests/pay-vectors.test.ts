/**
 * 第七批：各家金流的簽章／加密「官方範例向量」測試（全部離線、不打任何 API）。
 * 每一組都註明來源；竄改任一字元一律驗證失敗。官方公開的測試金鑰可以出現在這裡（不是任何商家的正式金鑰）。
 */
import { describe, expect, it } from "vitest";
import { aesCbcDecryptHex, aesCbcEncryptHex, aesGcmDecryptHex, aesGcmEncryptHex } from "@/lib/pay/crypto";
import { ECPAY_STAGE_TEST_MERCHANT, ecpayCheckMac, ecpayUrlEncode, ecpayVerifyMac, parseEcpayKv } from "@/lib/pay/ecpay";
import { newebpayCheckCode, newebpayCheckValue, newebpayDecryptJson, newebpayTradeSha } from "@/lib/pay/newebpay";
import { payuniHashInfo, parsePayuniPayload } from "@/lib/pay/payuni";
import { blackcatApnChecksum, classifyBlackcatProcessCode } from "@/lib/pay/blackcat";
import { classifyLinepayCheck, linepaySignature, parseLinepayJson } from "@/lib/pay/linepay";

const kv = (s: string) => Object.fromEntries(s.split("&").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));

describe("綠界 ECPay 金流 CheckMacValue（SHA256）", () => {
  // 來源：綠界全方位金流文件 CheckMacValue 檢查碼機制（https://developers.ecpay.com.tw/2902/）的建單範例與付款結果通知範例；
  // 與 Tinna 正式站 apps/api/test/ecpay.test.ts 收錄的官方向量相同。測試特店 3002607（https://developers.ecpay.com.tw/2856/ 公開測試值）。
  const { hashKey, hashIv } = ECPAY_STAGE_TEST_MERCHANT;
  it("AioCheckOut 建單範例", () => {
    const p = kv("TradeDesc=促銷方案&PaymentType=aio&MerchantTradeDate=2023/03/12 15:30:23&MerchantTradeNo=ecpay20230312153023&MerchantID=3002607&ReturnURL=https://www.ecpay.com.tw/receive.php&ItemName=Apple iphone 15&TotalAmount=30000&ChoosePayment=ALL&EncryptType=1");
    expect(ecpayCheckMac(p, hashKey, hashIv)).toBe("6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840");
  });
  it("付款結果通知範例（ReturnURL）＋竄改被拒、大小寫不敏感", () => {
    const p = kv("CustomField1=&CustomField2=&CustomField3=&CustomField4=&MerchantID=3002607&MerchantTradeNo=D9RMXNrihUYM&PaymentDate=2024/12/31 12:26:09&PaymentType=Credit_CreditCard&PaymentTypeChargeFee=10&RtnCode=1&RtnMsg=交易成功&SimulatePaid=0&StoreID=&TradeAmt=402&TradeDate=2024/12/31 12:25:43&TradeNo=2412311225437371");
    const mac = "85D927637935683EA756CDEF76498FEB9F5D098A7A1AC4F0CB3B3609A9D4116A";
    expect(ecpayCheckMac(p, hashKey, hashIv)).toBe(mac);
    expect(ecpayVerifyMac({ ...p, CheckMacValue: mac }, hashKey, hashIv)).toBe(true);
    expect(ecpayVerifyMac({ ...p, CheckMacValue: mac.toLowerCase() }, hashKey, hashIv)).toBe(true);
    expect(ecpayVerifyMac({ ...p, TradeAmt: "4020", CheckMacValue: mac }, hashKey, hashIv)).toBe(false);
    expect(ecpayVerifyMac({ ...p, CheckMacValue: mac.slice(0, -1) + "0" }, hashKey, hashIv)).toBe(false);
    expect(ecpayVerifyMac({ ...p, CheckMacValue: "" }, hashKey, hashIv)).toBe(false);
    expect(ecpayVerifyMac({ ...p, CheckMacValue: mac }, "wrongkey12345678", hashIv)).toBe(false);
  });
  it(".NET URL encode 規則；回應 key=value 只切第一個 =", () => {
    expect(ecpayUrlEncode("-_.!*() ")).toBe("-_.!*()+");
    expect(ecpayUrlEncode("~'")).toBe("%7E%27");
    expect(parseEcpayKv("A=1&B=x=y&C=")).toEqual({ A: "1", B: "x=y", C: "" });
  });
});

describe("藍新 NewebPay AES-256-CBC／TradeSha／CheckValue／CheckCode", () => {
  it("MPG 加密與 TradeSha（NDNF-1.2.6 §4.1.1–4.1.2 範例）", () => {
    // 來源：《線上交易─幕前支付技術串接手冊》NDNF-1.2.6（https://www.newebpay.com/website/Page/content/download_api）
    const key = "Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn";
    const iv = "C6AcmfqJILwgnhIP";
    const plain = "MerchantID=MS127874575&RespondType=String&TimeStamp=1695795410&Version=2.0&MerchantOrderNo=Vanespl_ec_1695795410&Amt=30&ItemDesc=test&NotifyURL=https%3A%2F%2Fwebhook.site%2Fd4db5ad1-2278-466a-9d66-78585c0dbadb";
    const enc = aesCbcEncryptHex(plain, key, iv);
    expect(enc.startsWith("f79eac33c4f3245d58f17b544c5d38b09457a6d77e77bae6f10fcc7236fe153c")).toBe(true);
    expect(enc.endsWith("d89e048be2ab6fd83f1c522494c093426a10a1f73fe4")).toBe(true);
    expect(newebpayTradeSha(enc, key, iv)).toBe("84E4D9F96537E029F8450BE1E759080F9AF6995921B7F6F9AAFDDD2C36E7B287");
    expect(aesCbcDecryptHex(enc, key, iv)).toBe(plain);
    // 竄改密文 → padding 錯或內容不同；改金鑰 → TradeSha 不同
    expect(() => aesCbcDecryptHex(enc.slice(0, -2) + (enc.endsWith("00") ? "11" : "00"), key, iv)).toThrow();
    expect(newebpayTradeSha(enc, key, "C6AcmfqJILwgnhIQ")).not.toBe("84E4D9F96537E029F8450BE1E759080F9AF6995921B7F6F9AAFDDD2C36E7B287");
  });
  it("QueryTradeInfo 回應 CheckCode（NDNF-1.2.6 §4.1.5 範例）", () => {
    const key = "Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn";
    const iv = "C6AcmfqJILwgnhIP";
    expect(newebpayCheckCode({ Amt: 30, MerchantID: "MS127874575", MerchantOrderNo: "Vanespl_ec_1695795668", TradeNo: "23092714215835071" }, key, iv)).toBe("79C5227AF869AE4F25FDF4E22B928D5B52E415D9905EC6912D7807E18C3FFACA");
    expect(newebpayCheckCode({ Amt: 31, MerchantID: "MS127874575", MerchantOrderNo: "Vanespl_ec_1695795668", TradeNo: "23092714215835071" }, key, iv)).not.toBe("79C5227AF869AE4F25FDF4E22B928D5B52E415D9905EC6912D7807E18C3FFACA");
    // CheckValue 格式（§4.1.6：IV=…&Amt&MerchantID&MerchantOrderNo&Key=…，大寫 64 hex）
    expect(newebpayCheckValue({ Amt: 30, MerchantID: "MS127874575", MerchantOrderNo: "X1" }, key, iv)).toMatch(/^[0-9A-F]{64}$/);
  });
  it("定期定額建立委託加密＋回傳解密（NDNP 手冊 §4.1／4.2 範例，商店 TEK1682407426）", () => {
    // 來源：《信用卡定期定額技術串接手冊》NDNP（同下載頁）；範例金鑰為手冊公開範例值
    const key = "IaWudQJsuOT994cpHRWzv7Ge67yC1cE3";
    const iv = "C1dLm3nxZRVlmBSP";
    const plain = "RespondType=JSON&TimeStamp=1700033460&Version=1.5&LangType=zh-Tw&MerOrderNo=myorder1700033460&ProdDesc=Test+commssion&PeriodAmt=10&PeriodType=M&PeriodPoint=05&PeriodStartType=2&PeriodTimes=12&PayerEmail=test%40neweb.com.tw&PaymentInfo=Y&OrderInfo=N&EmailModify=1&NotifyURL=https%3A%2F%2Fwebhook.site%2Fb728e917-1bf7-478b-b0f9-73b56aeb44e0";
    const enc = aesCbcEncryptHex(plain, key, iv);
    expect(enc).toBe(
      "45d5175feaa9ef2ea039f84afba34c6330e8fa21ae01ec40f15ab00073b4e93584cc1d3a7e2b26feb08216d14074dd4a83a64791e114cd15e200a88ef38720e7830d892953a25b84411abc8d0f86ff73719af52e0c303de9586c422702e806e599ffd739086b0c3f8c3b995b2a6ba92902070f5f8c4c2916f72b0d9c1027ca050799a6a55e78ff07c663e4b90aa3a84dfde353f1354fc5165ccc897f5ee0586a2852e2e5e1be1f3fa2f7a618377abdab9b6aa3af39eb005e461aaa2c8da4d2fd3af93bed9eb3438b01804a9a1bc39bcb6f7bd3a35bd275fe53923960bd76c4def1175e8b1f60acb21cd4ebe9c03fe10df2c1a6aa455e21899c02cba501ce2fb87c72a6cbb2a146ddd4688fd3ce9cf068bdb6f4f2c4351d78973d32268737e931def628d0f3f3aac038cd551a0f8c85e0d194542da74f6ba841c4068bab0f14453dbac0d16dba1de2656368238855dc6351821380a3455532a2259c2c5caf4cac",
    );
    const period =
      "e88f62186b6d5dd96a9f6dbc57a84547957e8cb8534d81cbed42dcffa93783a30fad037c450ed467d60f44e51b3525829e204ae0d3792a9f2c7e8af7df196ddc678579b76f76f64f0322f7e41587076372b69023b1681d022d219f78deced25f941e5902905f4f5009d84aa35f1c4dc0cee9bbd4ba9a67228775927a14ff86f46259388845ba59a1c59c3007bf5534bae63616e1e705a63dc9615d3be00d4bf04f04af1ebc229f34e34c80b31d14d39f519099650bfaa7f9228ad15c7f79797d3ada0ba648bb33a8fd82937061e83b2916b92510617d52cff39adb1b0d1204d9e07b3f79d709344852579671c68d8844348b80f4a35450d860b232f3aeb7728c24135e438f0893089e445bdc62429126a5b37c7e09b1226e05d53127498fbcf407f241c8d752298a29642df3671f8277b9849370d2234a69fbfd415ab3449953233a4eaa2e1aa5827f30c482cf8efcdecff5587f75045f60336eb2133b658834736642f99305f0d245c0714696a238b1d9364659f7240c25a1e66d04af35f7f077498dad65b82256342549ba34e2ff75880ef9fb1e025999ee619eef10388642a09eacebe3c19be1d8077ee1a73d53a7168e835a13361248a54d83d944b33ace6f8159aa38b9ab0b408bbab3bedb9affcf43a3ae4415c5a657a66ab026f7c53ada3b2920e741fa19c62bf19d21932239a3116ae3ccf0aabf06bb99ddcefb3976dbb75c45599a17f24fdedbb30e232c969fa2a1d5d1e21258ed21705ae969d97c756e742be64c7f4c6ed520b35fa5fa1689c40b3f8929f7ee082076cbcf585536e1f2e2ff1042934eaf57577efd7c403c562b1ea106aaea3e36f69e3eeba8e0ea";
    const d = newebpayDecryptJson(period, key, iv);
    expect(d).toMatchObject({ Status: "SUCCESS", Result: { MerchantID: "TEK1682407426", MerchantOrderNo: "myorder1700033460", PeriodAmt: "10", AuthTimes: 12, RespondCode: "00", PeriodNo: "P231115153213aMDNWZ" } });
    expect(() => newebpayDecryptJson(period, "IaWudQJsuOT994cpHRWzv7Ge67yC1cE4", iv)).toThrow();
  });
});

describe("PAYUNi AES-256-GCM EncryptInfo／HashInfo", () => {
  // 來源：PAYUNi 官方文件「資料加解密／PHP 範例」https://docs.payuni.com.tw/web/#/7/29（範例 Key／IV 為文件公開值）
  const key = "12345678901234567890123456789012";
  const iv = "1234567890123456";
  const official = "47396636346f66735853533167396942344f587a3775696b34752b596e70452b3a3a3a4373354a5a5143306b7153467531354c6e6f554a69773d3d";
  it("加密 MerID=AAA&MerTradeNo=BBB 等於官方結果；解密還原；竄改 tag 被拒", () => {
    expect(aesGcmEncryptHex("MerID=AAA&MerTradeNo=BBB", key, iv)).toBe(official);
    expect(aesGcmDecryptHex(official, key, iv)).toBe("MerID=AAA&MerTradeNo=BBB");
    const tampered = official.slice(0, 20) + (official[20] === "4" ? "5" : "4") + official.slice(21);
    expect(() => aesGcmDecryptHex(tampered, key, iv)).toThrow();
    expect(payuniHashInfo(official, key, iv)).toMatch(/^[0-9A-F]{64}$/);
    expect(payuniHashInfo(official, key, iv)).not.toBe(payuniHashInfo(official, key, "1234567890123457"));
  });
  it("查詢回應 Result[0][…] 攤平、外層 Status 優先", () => {
    expect(parsePayuniPayload("Status=SUCCESS&Message=ok&Result%5B0%5D%5BMerTradeNo%5D=GB1&Result%5B0%5D%5BTradeStatus%5D=1&Result%5B0%5D%5BTradeAmt%5D=500&Result%5B0%5D%5BStatus%5D=X")).toMatchObject({ Status: "SUCCESS", MerTradeNo: "GB1", TradeStatus: "1", TradeAmt: "500" });
    expect(parsePayuniPayload(JSON.stringify({ Status: "SUCCESS", Result: [{ MerTradeNo: "GB2", TradeStatus: "9" }] }))).toMatchObject({ Status: "SUCCESS", MerTradeNo: "GB2", TradeStatus: "9" });
  });
});

describe("黑貓 PAY APN checksum", () => {
  // 來源：「多元支付平台-WEBAPI介面規格 V1.28.2」P90（COCS APN）與 P38（CVS APN）範例（簽約後取得的規格書；
  // 與 alice-store/scripts/blackcat-selftest.mjs、快樂手正式站驗證過的向量相同）
  it("官方範例向量；🔴 checksum 不含祕密（任何人都算得出來）→ 只能當雜訊過濾，一定要回查", () => {
    const base = { api_id: "CC0000000001", trans_id: "550e8400e29b41d4a716446655440000", amount: "1250", status: "B", nonce: "1234569999" };
    expect(blackcatApnChecksum(base)).toBe("d09d5532767453ad4c6ba9b649034187");
    expect(blackcatApnChecksum({ ...base, api_id: "CV0000000000", status: "D" })).toBe("3579609ba3914a49441e98cb7e8a55de");
    expect(blackcatApnChecksum({ ...base, amount: "1" })).not.toBe("d09d5532767453ad4c6ba9b649034187");
  });
  it("process_code 判讀：15/20/21/22 已付；13/14 未完成；5/6/16/17/27 失敗；23 與未知 → unknown", () => {
    for (const c of [15, 20, 21, 22]) expect(classifyBlackcatProcessCode(c)).toBe("paid");
    for (const c of [13, 14]) expect(classifyBlackcatProcessCode(c)).toBe("pending");
    for (const c of [5, 6, 16, 17, 27]) expect(classifyBlackcatProcessCode(c)).toBe("failed");
    for (const c of [23, 99, undefined]) expect(classifyBlackcatProcessCode(c)).toBe("unknown");
  });
});

describe("LINE Pay 簽章與 transactionId 精度", () => {
  // LINE Pay 官方文件只給演算法（https://developers-pay.line.me/online/prerequisites），沒有公開範例向量：
  // 以下兩組來自 Tinna 正式站 test/linepay.test.ts（以 openssl 另行驗算），用來交叉驗證演算法。
  const secret = "a917ab6a2367b536f8e5a6e2977e06f4";
  const nonce = "3f1a8d2e-5b6c-4d7e-8f90-a1b2c3d4e5f6";
  it("HMAC-SHA256(secret, secret + uri + body + nonce) base64", () => {
    expect(linepaySignature(secret, "/v3/payments/request", '{"amount":3600,"currency":"TWD","orderId":"YS8K2M4Q7TABCDEFGHJK"}', nonce)).toBe("aR8NgeWpzPdQpQvUWrTFoUaffEa2oWur9SPaze3B7bE=");
    expect(linepaySignature(secret, "/v3/payments/2023042201206549310/confirm", '{"amount":3600,"currency":"TWD"}', nonce)).toBe("75O1Stb9tOcgYN+StBm1VHs/bmxITkrom+gYytcVKzc=");
    expect(linepaySignature(secret, "/v3/payments/2023042201206549310/confirm", '{"amount":3601,"currency":"TWD"}', nonce)).not.toBe("75O1Stb9tOcgYN+StBm1VHs/bmxITkrom+gYytcVKzc=");
  });
  it("19 位數 transactionId 不失真（JSON.parse 會把 2026053158491409700 變成 …664）", () => {
    expect(parseLinepayJson('{"returnCode":"0000","info":{"transactionId":2026053158491409700}}')).toMatchObject({ info: { transactionId: "2026053158491409700" } });
  });
  it("Check API returnCode（https://developers-pay.line.me/online-api-v3/check-payment-request-status）", () => {
    expect(classifyLinepayCheck("0123")).toEqual({ state: "paid" });
    expect(classifyLinepayCheck("0110")).toEqual({ state: "pending", needsConfirm: true });
    expect(classifyLinepayCheck("0000")).toEqual({ state: "pending" });
    expect(classifyLinepayCheck("0121").state).toBe("failed");
    expect(classifyLinepayCheck("0122").state).toBe("failed");
    expect(classifyLinepayCheck("9000").state).toBe("unknown");
  });
});
