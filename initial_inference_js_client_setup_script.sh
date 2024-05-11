#!/bin/bash

# Determine the user shell
user_shell=$(echo $SHELL)
echo "Detected user shell: $user_shell"

# Set shell path and profile file based on user shell
if [[ $user_shell == *"/zsh"* ]]; then
  profile_file=".zshrc"
else
  profile_file=".bashrc"
fi
echo "Using profile file: ~/$profile_file"

# Update code block with appropriate shell execution
if [ -d ~/pastel_inference_js_client ]; then
  echo "Directory exists. Stashing and pulling latest code..."
  cd ~/pastel_inference_js_client
  git stash
  git pull
else
  echo "Directory does not exist. Cloning repository..."
  git clone https://github.com/pastelnetwork/pastel_inference_js_client.git ~/pastel_inference_js_client
  cd ~/pastel_inference_js_client
fi

# Check if NVM is already installed; if not install it and configure it to use the latest version as the default
if [ ! -d "$HOME/.nvm" ]; then
  echo "Installing NVM..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
  [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
fi

nvm install --latest-npm
nvm use node
nvm alias default node

npm install