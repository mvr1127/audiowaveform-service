FROM ubuntu:22.04

# Install OS-level dependencies
RUN apt-get update && \
    apt-get install -y curl gnupg2 ca-certificates build-essential \
    ffmpeg wget unzip && \
    rm -rf /var/lib/apt/lists/*

# Install audiowaveform
RUN wget https://github.com/bbc/audiowaveform/releases/download/1.7.2/audiowaveform-1.7.2-linux64.tar.bz2 && \
    tar xjf audiowaveform-1.7.2-linux64.tar.bz2 && \
    mv audiowaveform-1.7.2-linux64/audiowaveform /usr/local/bin/audiowaveform && \
    chmod +x /usr/local/bin/audiowaveform && \
    rm -rf audiowaveform-1.7.2-linux64*

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
