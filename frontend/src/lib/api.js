import axios from "axios";
import { BACKEND_URL } from "./config";

const api = axios.create({
  baseURL: BACKEND_URL,
  withCredentials: true,
});

// 🔥 Automatically attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");

   if (token && token !== "undefined" && token !== "null") {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

export default api;
