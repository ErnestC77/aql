require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const sessions = {};

// ===== ВКЛАДКИ =====
const aircraftSheetMap = {
  "ER-BAS": "B747F",
  "ER-BYK": "B747F",

  "ER-GAG": "B777-B747PAX",
  "ER-JAN": "B777-B747PAX",
  "ER-HAJ": "B777-B747PAX",
  "ER-BOY": "B777-B747PAX",
  "ER-BOS": "B777-B747PAX",

  "ER-UFC": "B733F",
  "ER-BCT": "B733F",
  "P4-AQQ": "B733F",
};

const DEFAULT_SHEET_NAME = "Sheet1";
const ALL_SHEET_NAMES = [...new Set(Object.values(aircraftSheetMap))];

function getSheetNameByAircraft(aircraft) {
  return aircraftSheetMap[aircraft] || DEFAULT_SHEET_NAME;
}

// ===== ДАННЫЕ =====
const equipmentList = ["PAXSTEP","GPU","SCISSORLIFT","NITROGEN","JACK","DOLLY"];
const flightList = ["TVR4701","TVR4702","TVR4703","TVR4704","TVR4707","TVR4716","TVR4717"];

const baseFields = [
  { key: "Flight", label: "Номер рейса" },
  { key: "Date", label: "Дата" },
  { key: "CombinedInfo", label: "Самолёт, аэропорт, инженер" },
];

const editableFields = [
  { key: "Flight", col: 1 },
  { key: "Date", col: 2 },
  { key: "Equipment / Company", col: 3 },
  { key: "Time in", col: 4 },
  { key: "Time out", col: 5 },
  { key: "Aircraft", col: 8 },
  { key: "Airport", col: 9 },
  { key: "Engineer Name", col: 10 },
];

// ===== GOOGLE =====
async function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ===== УТИЛИТЫ =====
function short(t,m=24){return !t?"":t.length>m?t.substring(0,m-3)+"...":t;}
function todayDate(){return new Date().toLocaleDateString("ru-RU");}

function calculateUsage(a,b){
  if(!a||!b)return "";
  const [h1,m1]=a.split(":").map(Number);
  const [h2,m2]=b.split(":").map(Number);
  let s=h1*60+m1,e=h2*60+m2;
  if(e<s)e+=1440;
  return `${Math.floor((e-s)/60)}:${String((e-s)%60).padStart(2,"0")}`;
}

function parseDateTime(d,t){
  if(!d||!t)return null;
  const [day,mon,yr]=d.split(".").map(Number);
  const [h,m]=t.split(":").map(Number);
  return new Date(yr,mon-1,day,h,m);
}

// ===== WHATSAPP =====
async function sendMessage(to,text){
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    { messaging_product:"whatsapp",to,type:"text",text:{body:text}},
    { headers:{Authorization:`Bearer ${process.env.WHATSAPP_TOKEN}`} }
  );
}

// ===== СОХРАНЕНИЕ =====
async function saveRowsToSheet(baseData, equipmentEntries, createdBy) {
  const sheets = await getSheetsClient();
  const sheetName = getSheetNameByAircraft(baseData["Aircraft"]);
  const createdAt = new Date().toISOString();

  const rows = equipmentEntries.map((item) => [
    baseData["Flight"] || "",
    baseData["Date"] || "",
    item.equipment || "",
    item.timeIn || "",
    item.timeOut || "",
    calculateUsage(item.timeIn, item.timeOut),
    "", // G
    baseData["Aircraft"] || "",
    baseData["Airport"] || "",
    baseData["Engineer Name"] || "",
    "", // K
    createdBy,
    createdAt,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `'${sheetName}'!A:M`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

// ===== ЧТЕНИЕ =====
async function getAllRowsFromSheet(sheetName){
  const sheets=await getSheetsClient();
  const res=await sheets.spreadsheets.values.get({
    spreadsheetId:process.env.GOOGLE_SHEET_ID,
    range:`'${sheetName}'!A:M`,
  });
  return res.data.values||[];
}

// ===== ПОСЛЕДНИЕ 10 =====
async function getLast10Rows(user){
  const all=[];
  for(const s of ALL_SHEET_NAMES){
    const rows=await getAllRowsFromSheet(s);
    for(let i=1;i<rows.length;i++){
      const r=rows[i];
      if(r[11]!==user)continue;
      const dt=r[12]?new Date(r[12]):parseDateTime(r[1],r[3]);
      all.push({sheetName:s,rowNumber:i+1,row:r,createdAt:dt||new Date(0)});
    }
  }
  return all.sort((a,b)=>b.createdAt-a.createdAt).slice(0,10);
}

// ===== UPDATE =====
async function updateCell(sheet,row,col,val){
  const sheets=await getSheetsClient();
  const l=String.fromCharCode(64+col);
  await sheets.spreadsheets.values.update({
    spreadsheetId:process.env.GOOGLE_SHEET_ID,
    range:`'${sheet}'!${l}${row}`,
    valueInputOption:"USER_ENTERED",
    requestBody:{values:[[val]]},
  });
}

// ===== WEBHOOK =====
app.post("/webhook",async(req,res)=>{
  res.sendStatus(200);

  try{
    const msg=req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg)return;

    const from=msg.from;
    const text=msg.text?.body;

    if(!sessions[from])sessions[from]={};

    // ===== ДОБАВЛЕНИЕ (упрощённый пример) =====
    if(text==="test"){
      await saveRowsToSheet(
        {Flight:"TVR4701",Date:todayDate(),Aircraft:"ER-BAS",Airport:"SHJ","Engineer Name":"Test"},
        [{equipment:"GPU",timeIn:"10:00",timeOut:""}],
        from
      );
      await sendMessage(from,"Сохранено");
      return;
    }

    // ===== ДОПОЛНИТЬ =====
    if(text==="FILL"){
      const rows=await getLast10Rows(from);
      const missing=rows.filter(r=>r.row[3]&&!r.row[4]);

      if(!missing.length){
        await sendMessage(from,"Нет незаполненных");
        return;
      }

      const rec=missing[0];
      await updateCell(rec.sheetName,rec.rowNumber,5,"12:00");
      await sendMessage(from,"Время добавлено");
      return;
    }

  }catch(e){
    console.log(e.message);
  }
});

app.listen(process.env.PORT||3000);