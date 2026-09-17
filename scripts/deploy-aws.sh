#!/usr/bin/env bash
# ==============================================================================
# Open Interest — Turnkey AWS EC2 Automated Deployment Script
# Supports: Ubuntu 22.04 LTS & 24.04 LTS (HVM)
# Architecture: Single-Host Multi-Container Docker Compose Stack
# ==============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}====================================================================${NC}"
echo -e "${GREEN}   OPEN INTEREST — INSTITUTIONAL FUTURES TRADING PLATFORM          ${NC}"
echo -e "${GREEN}                 AWS EC2 AUTOMATED DEPLOYMENT                      ${NC}"
echo -e "${BLUE}====================================================================${NC}"

# 1. System Memory & Swap Check (Critical for Free Tier / Low-RAM instances)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
TOTAL_SWAP_KB=$(grep SwapTotal /proc/meminfo | awk '{print $2}')
TOTAL_SWAP_MB=$((TOTAL_SWAP_KB / 1024))

echo -e "\n${YELLOW}[1/5] Checking Memory & Swap Configuration...${NC}"
echo "Detected RAM:  ${TOTAL_RAM_MB} MB"
echo "Detected Swap: ${TOTAL_SWAP_MB} MB"

if [ "$TOTAL_SWAP_MB" -lt 2000 ]; then
    echo -e "${YELLOW}--> Memory footprint requires swap file. Creating 4 GB swapfile...${NC}"
    if [ -f /swapfile ]; then
        sudo swapoff /swapfile 2>/dev/null || true
        sudo rm -f /swapfile
    fi
    sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    if ! grep -q "/swapfile" /etc/fstab; then
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    fi
    echo -e "${GREEN}✓ 4 GB Swap space enabled successfully.${NC}"
else
    echo -e "${GREEN}✓ Swap space is already configured (${TOTAL_SWAP_MB} MB).${NC}"
fi

# 2. Check & Install Docker / Docker Compose
echo -e "\n${YELLOW}[2/5] Checking Docker & Docker Compose installation...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}--> Installing Docker CE and Docker Compose plugin...${NC}"
    sudo apt-get update -y
    sudo apt-get install -y ca-certificates curl gnupg lsb-release

    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -y
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER" 2>/dev/null || true
    echo -e "${GREEN}✓ Docker engine installed successfully.${NC}"
else
    echo -e "${GREEN}✓ Docker is already installed: $(docker --version)${NC}"
fi

# 3. Environment Configuration Check
echo -e "\n${YELLOW}[3/5] Verifying environment configuration (.env)...${NC}"
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "Creating .env from .env.example..."
        cp .env.example .env
        echo -e "${GREEN}✓ Initialized .env from template.${NC}"
    else
        echo -e "${RED}Error: Neither .env nor .env.example found.${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ .env file present.${NC}"
fi

# 4. Build and Launch Containers
echo -e "\n${YELLOW}[4/5] Building and launching 8 Docker containers...${NC}"
docker compose down --remove-orphans 2>/dev/null || true
docker compose build
docker compose up -d

# 5. Health Status & Completion
echo -e "\n${YELLOW}[5/5] Waiting for services to initialize...${NC}"
sleep 10
docker compose ps

# Detect Public IP
PUBLIC_IP=$(curl -s https://checkip.amazonaws.com || curl -s https://ifconfig.me || echo "YOUR-EC2-PUBLIC-IP")

echo -e "\n${BLUE}====================================================================${NC}"
echo -e "${GREEN}   🚀 OPEN INTEREST IS NOW DEPLOYED AND LIVE!                     ${NC}"
echo -e "${BLUE}====================================================================${NC}"
echo -e "Web Terminal:      ${GREEN}http://${PUBLIC_IP}${NC}"
echo -e "Kafka UI:          ${YELLOW}http://${PUBLIC_IP}:8080${NC} (if port 8080 is open in Security Group)"
echo -e "\nDefault Seed Accounts:"
echo -e "  • Administrator: Username: ${GREEN}admin${NC}   / Password: ${GREEN}T@jFUHkUVzkHoNhbj#98!${NC}"
echo -e "  • Head Trader:   Username: ${GREEN}trader1${NC} / Password: ${GREEN}Tr1#oHMACIn3Am79!${NC}"
echo -e "  • Quant Trader:  Username: ${GREEN}trader2${NC} / Password: ${GREEN}Tr2#sEcuR3Pass99!${NC}"
echo -e "\nUseful Management Commands:"
echo -e "  • View container status:  ${BLUE}docker compose ps${NC}"
echo -e "  • Stream live logs:       ${BLUE}docker compose logs -f${NC}"
echo -e "  • Stop platform:          ${BLUE}docker compose down${NC}"
echo -e "  • Restart platform:       ${BLUE}docker compose restart${NC}"
echo -e "${BLUE}====================================================================${NC}\n"
