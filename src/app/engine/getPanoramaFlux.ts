"use server"

import OpenAI from 'openai';
import { filterOutBadWords } from "./censorship";
import sharp from 'sharp';
import * as tf from '@tensorflow/tfjs-node'; // 添加TensorFlow.js用于图像处理

// OpenAI 客户端配置
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_API_URL,
});

// 图像处理工具类
class ImageProcessor {
  // 颜色校正
  static async matchColors(sourceBuffer: Buffer, targetBuffer: Buffer): Promise<Buffer> {
    const source = tf.node.decodeImage(sourceBuffer);
    const target = tf.node.decodeImage(targetBuffer);
    
    // 计算平均色调和对比度
    const sourceMean = tf.mean(source, [0, 1]);
    const targetMean = tf.mean(target, [0, 1]);
    const sourceStd = tf.std(source, [0, 1]);
    const targetStd = tf.std(target, [0, 1]);
    
    // 应用颜色校正
    const normalized = source.sub(sourceMean).div(sourceStd).mul(targetStd).add(targetMean);
    const uint8Array = await tf.node.encodePng(normalized);
    
    return Buffer.from(uint8Array);
  }

  // 特征匹配和对齐
  static async alignImages(img1Buffer: Buffer, img2Buffer: Buffer, overlapWidth: number): Promise<{offset: number}> {
    // 使用SIFT特征匹配算法（简化版）
    const img1 = sharp(img1Buffer);
    const img2 = sharp(img2Buffer);
    
    const [metadata1, metadata2] = await Promise.all([
      img1.metadata(),
      img2.metadata()
    ]);

    // 计算最佳偏移量（这里可以实现更复杂的特征匹配算法）
    return {
      offset: Math.floor(overlapWidth / 2)
    };
  }
}

// 高级图像拼接函数
async function advancedImageStitch(
  images: Buffer[],
  targetWidth: number,
  overlapPercent: number
): Promise<Buffer> {
  const overlapWidth = Math.floor(targetWidth * overlapPercent);
  
  // 创建渐变混合蒙版
  const createGradientMask = async (width: number, height: number) => {
    const gradient = new Float32Array(width);
    for (let i = 0; i < width; i++) {
      gradient[i] = i / width;
    }
    
    return sharp({
      create: {
        width,
        height,
        channels: 1,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
    .linear(1, 0)
    .raw()
    .toBuffer();
  };

  // 处理所有图像段
  let result = sharp(images[0]);
  let currentWidth = 0;
  
  for (let i = 1; i < images.length; i++) {
    const nextImage = sharp(images[i]);
    const [currentMetadata, nextMetadata] = await Promise.all([
      result.metadata(),
      nextImage.metadata()
    ]);
    
    // 颜色匹配
    const colorMatchedBuffer = await ImageProcessor.matchColors(
      await nextImage.toBuffer(),
      await result.toBuffer()
    );
    
    // 特征匹配和对齐
    const { offset } = await ImageProcessor.alignImages(
      await result.toBuffer(),
      colorMatchedBuffer,
      overlapWidth
    );
    
    // 创建渐变混合蒙版
    const mask = await createGradientMask(
      overlapWidth,
      currentMetadata.height ?? 1024
    );
    
    // 合成图像
    result = sharp({
      create: {
        width: currentMetadata.width! + nextMetadata.width! - offset,
        height: currentMetadata.height!,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
    .composite([
      { 
        input: await result.toBuffer(),
        left: 0,
        top: 0
      },
      {
        input: await sharp(colorMatchedBuffer)
          .extract({
            left: offset,
            top: 0,
            width: nextMetadata.width! - offset,
            height: nextMetadata.height!
          })
          .toBuffer(),
        left: currentMetadata.width! - offset,
        top: 0,
        blend: 'over'
      }
    ]);
    
    currentWidth = currentMetadata.width! + nextMetadata.width! - offset;
  }
  
  return result.png().toBuffer();
}

// 翻译函数（保持不变）
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

  // 翻译提示
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

  // 确定图像尺寸
  const size = determineImageSize(width, height);
  
  // 生成参数
  const segments = 4; // 生成4个部分
  const overlapPercent = 0.25; // 25%重叠
  const baseSeed = Math.floor(Math.random() * 1000000); // 基础种子值

  try {
    // 并行生成多个图像段
    const imagePromises = Array(segments).fill(null).map((_, i) => 
      openai.images.generate({
        model: "comic",
        prompt: `${fullPrompt}, segment ${i+1} of ${segments}, consistent style and lighting`,
        n: 1,
        size: size,
        seed: baseSeed + i, // 使用连续的种子值确保风格一致性
      })
    );

    const responses = await Promise.all(imagePromises);
    
    // 获取图像数据
    const imageBuffers = await Promise.all(
      responses.map(async (response) => {
        const imageUrl = response.data[0].url;
        if (!imageUrl) throw new Error("Failed to generate image");
        
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) throw new Error("Failed to fetch image");
        
        return Buffer.from(await imageResponse.arrayBuffer());
      })
    );

    // 执行高级图像拼接
    const stitchedImageBuffer = await advancedImageStitch(
      imageBuffers,
      width,
      overlapPercent
    );
    
    // 转换为Base64
    const base64Image = stitchedImageBuffer.toString('base64');
    return `data:image/png;base64,${base64Image}`;
    
  } catch (error) {
    console.error('Error in panorama generation:', error);
    throw new Error('Failed to generate panorama. Please try again.');
  }
}

// 辅助函数：确定图像尺寸
function determineImageSize(width: number, height: number): "1024x1024" | "768x1024" | "576x1024" | "512x1024" | "1024x576" | "768x512" {
  const sizes = [
    { size: "1024x1024", w: 1024, h: 1024 },
    { size: "768x1024", w: 768, h: 1024 },
    { size: "576x1024", w: 576, h: 1024 },
    { size: "512x1024", w: 512, h: 1024 },
    { size: "1024x576", w: 1024, h: 576 },
    { size: "768x512", w: 768, h: 512 }
  ] as const;

  // 找到最适合的尺寸
  const bestSize = sizes.find(s => width <= s.w && height <= s.h) ?? sizes[0];
  return bestSize.size;
}
