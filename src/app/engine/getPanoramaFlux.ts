"use server"

import OpenAI from 'openai';
import { filterOutBadWords } from "./censorship"
import sharp from 'sharp'; // 用于图像处理

// 创建OpenAI客户端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_URL,
});

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
    // 使用可选链操作符
    return response?.choices[0]?.message?.content?.trim() ?? "翻译失败";
  } catch (error) {
    console.error('翻译出错:', error);
    throw error;
  }
}

// 智能图像拼接函数
async function intelligentImageStitch(
  mainImageBuffer: Buffer,
  fillImageBuffer: Buffer,
  targetWidth: number
): Promise<Buffer> {
  const mainImage = sharp(mainImageBuffer);
  const fillImage = sharp(fillImageBuffer);
  
  const [mainMetadata, fillMetadata] = await Promise.all([
    mainImage.metadata(),
    fillImage.metadata()
  ]);

  // 计算需要从填充图像中裁剪的宽度
  const mainWidth = mainMetadata.width ?? targetWidth;
  const cropWidth = targetWidth - mainWidth;
  
  // 从填充图像的中间部分裁剪所需宽度
  const fillWidth = fillMetadata.width ?? targetWidth;
  const fillHeight = fillMetadata.height ?? targetWidth; // 假设高度默认等于目标宽度
  const croppedFillImage = fillImage.extract({
    left: Math.max(0, Math.floor((fillWidth - cropWidth) / 2)),
    top: 0,
    width: Math.min(cropWidth, fillWidth),
    height: fillHeight
  });

  // 创建最终的全景图像
  const mainHeight = mainMetadata.height ?? targetWidth;
  return sharp({
    create: {
      width: targetWidth,
      height: mainHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: await mainImage.toBuffer(), left: 0, top: 0 },
      { input: await croppedFillImage.toBuffer(), left: mainWidth, top: 0 }
    ])
    .png()
    .toBuffer();
}

export async function getPanoramaFlux({
  prompt,
  width,
  height,
  model, // 新增模型参数
}: {
  prompt: string
  width: number
  height: number
  model: string // 新增模型参数类型
}): Promise<string> {
  if (!prompt) {
    console.error(`无法在没有提示的情况下调用渲染API,正在中止..`)
    throw new Error(`无法在没有提示的情况下调用渲染API,正在中止..`)
  }

  // 翻译非英文提示
  let translatedPrompt = prompt;
  if (!/^[a-zA-Z\s]*$/.test(prompt)) {
    translatedPrompt = await translateToEnglish(prompt);
  }

  const fullPrompt = [
    `HDRI panoramic view of TOK`,
    filterOutBadWords(translatedPrompt),
    `highly detailed`,
    `intricate details`,
  ].join(', ')

  console.log(`使用以下提示调用API: ${fullPrompt}`)

  let size: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792" | null | undefined;

  if (width <= 256 && height <= 256) {
    size = "256x256";
  } else if (width <= 512 && height <= 512) {
    size = "512x512";
  } else if (width <= 1024 && height <= 1024) {
    size = "1024x1024";
  } else if (width <= 1792 && height <= 1024) {
    size = "1792x1024";
  } else if (width <= 1024 && height <= 1792) {
    size = "1024x1792";
  } else {
    // 如果尺寸超出预定义范围，可以选择最大尺寸或返回 null
    size = "1024x1792"; // 或 null
  }

  try {
    // 生成主图和填充图
    const [mainResponse, fillResponse] = await Promise.all([
      openai.images.generate({
        model: model, // 使用传入的模型参数
        prompt: fullPrompt + ", complete panoramic view",
        n: 1,
        size: size,
      }),
      openai.images.generate({
        model: model, // 使用传入的模型参数
        prompt: fullPrompt + ", extended view for panorama",
        n: 1,
        size: size,
      })
    ]);

    const mainImageUrl = mainResponse.data[0].url;
    const fillImageUrl = fillResponse.data[0].url;
    
    if (!mainImageUrl || !fillImageUrl) {
      throw new Error("无法获取图像URL");
    }

    // 获取两张图像的数据
    const [mainImageResponse, fillImageResponse] = await Promise.all([
      fetch(mainImageUrl),
      fetch(fillImageUrl)
    ]);

    if (!mainImageResponse.ok || !fillImageResponse.ok) {
      throw new Error("获取图像数据失败");
    }

    const [mainImageBuffer, fillImageBuffer] = await Promise.all([
      mainImageResponse.arrayBuffer(),
      fillImageResponse.arrayBuffer()
    ]);
    
    // 智能拼接图像
    const stitchedImageBuffer = await intelligentImageStitch(
      Buffer.from(mainImageBuffer),
      Buffer.from(fillImageBuffer),
      width * 1.5 // 扩展宽度为原始宽度的1.5倍
    );
    
    // 将拼接后的图像数据转换为Base64
    const base64Image = stitchedImageBuffer.toString('base64');
    const mimeType = 'image/png';

    return `data:${mimeType};base64,${base64Image}`;
  } catch (error) {
    console.error('图像生成或处理过程中出错:', error);
    throw new Error('图像生成失败，请稍后重试');
  }
}
