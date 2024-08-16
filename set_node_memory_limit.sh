#!/bin/bash

# Memory limit to set (in MB)
MEMORY_LIMIT=4096

# The alias command to set the Node.js memory limit
ALIAS_COMMAND="alias node=\"node --max-old-space-size=${MEMORY_LIMIT}\""

# Check if the alias is already in the .zshrc file
if grep -q "alias node=" ~/.zshrc; then
    echo "Updating existing Node.js memory limit alias in .zshrc"
    sed -i.bak "s/alias node=.*/$ALIAS_COMMAND/" ~/.zshrc
else
    echo "Adding Node.js memory limit alias to .zshrc"
    echo "$ALIAS_COMMAND" >> ~/.zshrc
fi

echo "Node.js memory limit set to ${MEMORY_LIMIT} MB globally for zsh."
echo "Please run 'source ~/.zshrc' in your zsh session to apply the changes."
