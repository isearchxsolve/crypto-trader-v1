import json
import os

# Update executor_paper.py trading parameters
executor_paper_path = "executor_paper.py"
with open(executor_paper_path, 'r') as f:
    content = f.read()

# Make aggressive changes for 1000x ROI
content = content.replace('self.default_stop_loss_pct = 0.06       # tight 6% stop', 'self.default_stop_loss_pct = 0.08       # moderate 8% stop')
content = content.replace('self.default_take_profit_pct = 0.15     # 15% TP (HWR/MG)', 'self.default_take_profit_pct = 0.35     # 35% TP (HWR/MG)')
content = content.replace('self.sniper_take_profit_pct = 0.25      # 25% TP (SNIPER early entries)', 'self.sniper_take_profit_pct = 0.60      # 60% TP (SNIPER early entries)')
content = content.replace('self.max_account_risk_pct = 0.40        # cap at 40% of account per trade', 'self.max_account_risk_pct = 0.25        # cap at 25% of account per trade (higher risk for higher returns)')

with open(executor_paper_path, 'w') as f:
    f.write(content)

# Update real_world_stress_test.py trading parameters
real_world_path = "real_world_stress_test.py"
with open(real_world_path, 'r') as f:
    content = f.read()

content = content.replace('"stop_loss_pct": 0.06,', '"stop_loss_pct": 0.08,')
content = content.replace('"take_profit_pct": 0.15 if mode != "SNIPER" else 0.25,', '"take_profit_pct": 0.35 if mode != "SNIPER" else 0.60,')

with open(real_world_path, 'w') as f:
    f.write(content)

# Update test_aggressive.py trading parameters
test_aggressive_path = "test_aggressive.py"
with open(test_aggressive_path, 'r') as f:
    content = f.read()

content = content.replace('"stop_loss_pct": 0.06,', '"stop_loss_pct": 0.08,')
content = content.replace('"take_profit_pct": 0.15 if mode != "SNIPER" else 0.25,', '"take_profit_pct": 0.35 if mode != "SNIPER" else 0.60,')

with open(test_aggressive_path, 'w') as f:
    f.write(content)

print("Trading configuration updated for 1000x ROI targeting!")
print("Changes made:")
print("- Stop loss: 6% -> 8%")
print("- Take profit: 15% -> 35%, SNIPER: 25% -> 60%")
print("- Max account risk: 40% -> 25% (allows larger position sizing)")
