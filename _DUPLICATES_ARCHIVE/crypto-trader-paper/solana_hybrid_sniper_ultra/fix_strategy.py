import re

# Update strategy.py trading parameters
strategy_path = "strategy.py"
with open(strategy_path, 'r') as f:
    content = f.read()

# Update take profit percentages in strategy.py
# These are in the _generate_signal method calls
content = content.replace('stop_loss_pct=0.06, take_profit_pct=0.15)', 'stop_loss_pct=0.06, take_profit_pct=0.35)')
content = content.replace('stop_loss_pct=0.06, take_profit_pct=0.18)', 'stop_loss_pct=0.06, take_profit_pct=0.45)')
content = content.replace('stop_loss_pct=0.06, take_profit_pct=0.25)', 'stop_loss_pct=0.06, take_profit_pct=0.60)')

with open(strategy_path, 'w') as f:
    f.write(content)

print("Strategy configuration updated for 1000x ROI targeting!")
