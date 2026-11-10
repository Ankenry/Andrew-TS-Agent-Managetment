import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins:[react()], server:{host:'127.0.0.1',port:5191,strictPort:true,fs:{deny:['**/.env*','**/*.{crt,pem,key}','**/.git/**','**/.impeccable/**','**/PRODUCT.md','**/DESIGN.md','**/server/**','**/tests/**','**/.runtime/**']},proxy:{'/api':'http://127.0.0.1:5190'}} });
