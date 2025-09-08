# Use Node.js 18 on Alpine Linux for a lightweight image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copying package files first lets Docker cache npm install, speeding up builds when only source code changes.
# Using COPY . . before RUN npm install causes dependencies to reinstall on any code change, even small ones.

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm install

# Copy rest of the project files
COPY . .

# Expose port 3000
EXPOSE 3000

# Start the application
CMD ["npm", "start"]