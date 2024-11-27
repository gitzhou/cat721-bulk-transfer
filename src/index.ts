import dotenv from 'dotenv';

dotenv.config();

console.log(process.env.GREETINGS || 'Hello, World!');
