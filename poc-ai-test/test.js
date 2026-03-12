import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const PROMPT_TEXT = 'Di solo "hola" y nada más. Sin explicaciones.';
const PROMPT_IMAGE = '¿Qué concierto anuncia esta imagen? Dame artista, fecha y lugar si los ves.';
const IMAGE_PATH = path.resolve('./8dabb7e5-18d4-4399-8e62-e6266dfa16cd.jfif');

// ─── Helpers ────────────────────────────────────────────────────────────────

function ok(name, text, ms) {
  console.log(`✅ ${name} (${ms}ms): "${text.trim()}"`);
}

function fail(name, err) {
  console.log(`❌ ${name}: ${err.message ?? err}`);
}

async function timed(fn) {
  const start = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - start };
}

function loadImageBase64() {
  const data = fs.readFileSync(IMAGE_PATH);
  return data.toString('base64');
}

// ─── Tests de texto ──────────────────────────────────────────────────────────

async function testGroq() {
  const key = process.env.GROQ_API_KEY;
  if (!key) return console.log('⏭️  Groq (texto): sin clave, saltando');

  try {
    const client = new Groq({ apiKey: key });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: PROMPT_TEXT }],
        max_tokens: 10,
      })
    );
    ok('Groq (texto)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('Groq (texto)', e);
  }
}

async function testGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return console.log('⏭️  Gemini (texto): sin clave, saltando');

  try {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const { result, ms } = await timed(() => model.generateContent(PROMPT_TEXT));
    ok('Gemini (texto)', result.response.text(), ms);
  } catch (e) {
    fail('Gemini (texto)', e);
  }
}

async function testMistral() {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) return console.log('⏭️  Mistral (texto): sin clave, saltando');

  try {
    const { result, ms } = await timed(() =>
      fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'mistral-small-latest',
          messages: [{ role: 'user', content: PROMPT_TEXT }],
          max_tokens: 10,
        }),
      }).then((r) => r.json())
    );
    if (result.error) throw new Error(result.error.message);
    ok('Mistral (texto)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('Mistral (texto)', e);
  }
}

async function testOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return console.log('⏭️  OpenAI (texto): sin clave, saltando');

  try {
    const client = new OpenAI({ apiKey: key });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: PROMPT_TEXT }],
        max_tokens: 10,
      })
    );
    ok('OpenAI (texto)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('OpenAI (texto)', e);
  }
}

// ─── Tests de imagen ─────────────────────────────────────────────────────────

async function testGroqImage() {
  const key = process.env.GROQ_API_KEY;
  if (!key) return console.log('⏭️  Groq (imagen): sin clave, saltando');

  try {
    const b64 = loadImageBase64();
    const client = new Groq({ apiKey: key });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              { type: 'text', text: PROMPT_IMAGE },
            ],
          },
        ],
        max_tokens: 200,
      })
    );
    ok('Groq (imagen)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('Groq (imagen)', e);
  }
}

async function testGeminiImage() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return console.log('⏭️  Gemini (imagen): sin clave, saltando');

  try {
    const b64 = loadImageBase64();
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const { result, ms } = await timed(() =>
      model.generateContent([
        { inlineData: { mimeType: 'image/jpeg', data: b64 } },
        PROMPT_IMAGE,
      ])
    );
    ok('Gemini (imagen)', result.response.text(), ms);
  } catch (e) {
    fail('Gemini (imagen)', e);
  }
}

async function testMistralImage() {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) return console.log('⏭️  Mistral (imagen): sin clave, saltando');

  try {
    const b64 = loadImageBase64();
    const { result, ms } = await timed(() =>
      fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'pixtral-12b-2409',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
                { type: 'text', text: PROMPT_IMAGE },
              ],
            },
          ],
          max_tokens: 200,
        }),
      }).then((r) => r.json())
    );
    if (result.error) throw new Error(JSON.stringify(result.error));
    if (!result.choices) throw new Error(`Respuesta inesperada: ${JSON.stringify(result)}`);
    ok('Mistral (imagen)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('Mistral (imagen)', e);
  }
}

async function testOpenAIImage() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return console.log('⏭️  OpenAI (imagen): sin clave, saltando');

  try {
    const b64 = loadImageBase64();
    const client = new OpenAI({ apiKey: key });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              { type: 'text', text: PROMPT_IMAGE },
            ],
          },
        ],
        max_tokens: 200,
      })
    );
    ok('OpenAI (imagen)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('OpenAI (imagen)', e);
  }
}

// ─── Anthropic (Claude) ───────────────────────────────────────────────────────

async function testAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return console.log('⏭️  Anthropic (texto): sin clave, saltando');

  try {
    const client = new Anthropic({ apiKey: key });
    const { result, ms } = await timed(() =>
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: PROMPT_TEXT }],
      })
    );
    ok('Anthropic (texto)', result.content[0].text, ms);
  } catch (e) {
    fail('Anthropic (texto)', e);
  }
}

async function testAnthropicImage() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return console.log('⏭️  Anthropic (imagen): sin clave, saltando');

  try {
    const b64 = loadImageBase64();
    const client = new Anthropic({ apiKey: key });
    const { result, ms } = await timed(() =>
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
              { type: 'text', text: PROMPT_IMAGE },
            ],
          },
        ],
      })
    );
    ok('Anthropic (imagen)', result.content[0].text, ms);
  } catch (e) {
    fail('Anthropic (imagen)', e);
  }
}

// ─── Together AI ──────────────────────────────────────────────────────────────

async function testTogether() {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) return console.log('⏭️  Together (texto): sin clave, saltando');

  try {
    const client = new OpenAI({ apiKey: key, baseURL: 'https://api.together.xyz/v1' });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        messages: [{ role: 'user', content: PROMPT_TEXT }],
        max_tokens: 10,
      })
    );
    ok('Together (texto)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('Together (texto)', e);
  }
}

async function testTogetherImage() {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) return console.log('⏭️  Together (imagen): sin clave, saltando');

  try {
    const b64 = loadImageBase64();
    const client = new OpenAI({ apiKey: key, baseURL: 'https://api.together.xyz/v1' });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              { type: 'text', text: PROMPT_IMAGE },
            ],
          },
        ],
        max_tokens: 200,
      })
    );
    ok('Together (imagen)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('Together (imagen)', e);
  }
}

// ─── OpenRouter ───────────────────────────────────────────────────────────────

async function testOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return console.log('⏭️  OpenRouter (texto): sin clave, saltando');

  try {
    const client = new OpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1' });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        messages: [{ role: 'user', content: PROMPT_TEXT }],
        max_tokens: 10,
      })
    );
    ok('OpenRouter (texto)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('OpenRouter (texto)', e);
  }
}

async function testOpenRouterImage() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return console.log('⏭️  OpenRouter (imagen): sin clave, saltando');

  try {
    const b64 = loadImageBase64();
    const client = new OpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1' });
    const { result, ms } = await timed(() =>
      client.chat.completions.create({
        model: 'meta-llama/llama-4-scout:free',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              { type: 'text', text: PROMPT_IMAGE },
            ],
          },
        ],
        max_tokens: 200,
      })
    );
    ok('OpenRouter (imagen)', result.choices[0].message.content, ms);
  } catch (e) {
    fail('OpenRouter (imagen)', e);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('🔍 Test de texto\n');
await testGroq();
await testGemini();
await testMistral();
await testOpenAI();
await testAnthropic();
await testTogether();
await testOpenRouter();

console.log('\n🖼️  Test de imagen (cartel de concierto)\n');
await testGroqImage();
await testGeminiImage();
await testMistralImage();
await testOpenAIImage();
await testAnthropicImage();
await testTogetherImage();
await testOpenRouterImage();

console.log('\n✨ Listo');
