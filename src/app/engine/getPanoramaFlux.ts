"use server"

import OpenAI from 'openai';
import { filterOutBadWords } from "./censorship";
import sharp from 'sharp';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_URL,
});

// 优化的图像拼接函数
async function simpleImageStitch(images: Buffer[]): Promise<Buffer> {
  if (images.length === 0) {
    throw new Error("No images to stitch");
  }

  // 获取第一张图片的尺寸
  const firstImage = sharp(images[0]);
  const metadata = await firstImage.metadata();
  const singleWidth = metadata.width || 1024;
  const height = metadata.height || 1024;

  // 创建一个足够大的画布
  const totalWidth = singleWidth * images.length;
  
  const composite = images.map((buffer, index) => ({
    input: buffer,
    left: index * singleWidth,
    top: 0
  }));

  return sharp({
    create: {
      width: totalWidth,
      height: height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
  .composite(composite)
  .png()
  .toBuffer();
}

// 翻译函数
async function translateToEnglish(text: string) {
  try {
    const response = await openai.chat.completions.create({
      model: "comic-c",
      messages: [
        { role: "system", content: "You are a translator. Translate the following text to English." },
        { role: "user", content: text }
      ],
    });
    return response?.choices[0]?.message?.content?.trim() ?? "Translation failed";
  } catch (error) {
    console.error('Translation error:', error);
    throw error;
  }
}

// 主函数
export async function getPanoramaFlux({
  prompt,
  width,
  height,
}: {
  prompt: string
  width: number
  height: number
}): Promise<string> {
  if (!prompt) {
    throw new Error("Cannot call rendering API without a prompt");
  }

  let translatedPrompt = prompt;
  if (!/^[a-zA-Z\s]*$/.test(prompt)) {
    translatedPrompt = await translateToEnglish(prompt);
  }

  const fullPrompt = [
    `HDRI panoramic view of TOK`,
    filterOutBadWords(translatedPrompt),
    `highly detailed`,
    `intricate details`,
    `seamless panorama`,
    `consistent lighting and style`
  ].join(', ');

  const size = determineImageSize(width, height);
  const segments = 2;//图片张数
  const baseSeed = Math.floor(Math.random() * 1000000);

  try {
    const imagePromises = Array(segments).fill(null).map((_, i) => 
      openai.images.generate({
        model: "comic",
        prompt: `${fullPrompt}, segment ${i+1} of ${segments}, consistent style and lighting`,
        n: 1,
        size: size,
      })
    );

    const responses = await Promise.all(imagePromises);
    
    const imageBuffers = await Promise.all(
      responses.map(async (response) => {
        const imageUrl = response.data[0].url;
        if (!imageUrl) throw new Error("Failed to generate image");
        
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) throw new Error("Failed to fetch image");
        
        return Buffer.from(await imageResponse.arrayBuffer());
      })
    );

    //拼接函数
    const stitchedImageBuffer = await simpleImageStitch(imageBuffers);
    
    return `data:image/png;base64,${stitchedImageBuffer.toString('base64')}`;
    
  } catch (error) {
    console.error('Error in panorama generation:', error);
    throw new Error('Failed to generate panorama. Please try again.');
  }
}

function determineImageSize(width: number, height: number): "1024x1024" | "256x256" | "512x512" | "1792x1024" | "1024x1792" | null | undefined {
  const sizes = [
    { size: "1024x1024", w: 1024, h: 1024 },
    { size: "256x256", w: 256, h: 256 },
    { size: "512x512", w: 512, h: 512 },
    { size: "1792x1024", w: 1792, h: 1024 },
    { size: "1024x1792", w: 1024, h: 1792 },
  ] as const;

  const bestSize = sizes.find(s => width <= s.w && height <= s.h) ?? sizes[0];
  return bestSize.size;
}