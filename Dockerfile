FROM ubuntu:22.04

# Install OS-level dependencies
RUN apt-get update && \
    apt-get install -y curl gnupg2 ca-certificates build-essential \
    ffmpeg wget unzip && \
    rm -rf /var/lib/apt/lists/*

# Install audiowaveform
RUN wget https://github.com/bbc/audiowaveform/releases/download/1.10.2/audiowaveform_1.10.2-1-12_amd64.deb && \
    apt-get update && \
    apt-get install -y ./audiowaveform_1.10.2-1-12_amd64.deb && \
    rm audiowaveform_1.10.2-1-12_amd64.deb

# Install Node.js via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm

# Set working directory
WORKDIR /app

# Copy and install app
COPY package.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
