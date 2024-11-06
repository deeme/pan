"use client"

import { create } from "zustand"

export const useStore = create<{
  prompt: string
  assetUrl: string
  isLoading: boolean
  selectedModel: string // 新增：选中的模型
  setLoading: (isLoading: boolean) => void
  setAssetUrl: (assetUrl: string) => void
  setPrompt: (prompt: string) => void
  setSelectedModel: (model: string) => void // 新增：设置选中模型的函数
}>((set, get) => ({
  prompt: "an outdoor japanese onsen in snowy mountains during the morning",
  assetUrl: "",
  isLoading: false,
  selectedModel: "comic", // 新增：默认选中的模型
  setSelectedModel: (model: string) => {
    set({ selectedModel: model })
  },
  setLoading: (isLoading: boolean) => {
    set({ isLoading })
  },
  setAssetUrl: (assetUrl: string) => {
    set({
      assetUrl
    })
  },
  setPrompt: (prompt: string) => {
    set({
      prompt,
    })
  }
}))
