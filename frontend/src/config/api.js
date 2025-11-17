// src/config/api.js
// Centralized API base URL configuration
// Supports both Create React App (REACT_APP_*) and Vite (VITE_*) environment variables

const REACT_API = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined;
const VITE_API = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined;
const FALLBACK_API = typeof process !== 'undefined' && process.env ? process.env.API_BASE : undefined;

export const API_BASE = REACT_API || VITE_API || FALLBACK_API || 'http://localhost:3000';

export default API_BASE;

