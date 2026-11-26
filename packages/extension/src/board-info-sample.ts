// examples/board-info-sample.csv, shipped in the extension so Load Board Info can save it as a template; a test keeps the two equal.
export const BOARD_INFO_SAMPLE_CSV = `row,net,kind,protocol,speed,driver_part,driver_pin,driver_pin_name,receivers,diff_partner,reference,target,voltage,source_part,source_pin,load_part,load_pin,typical_current,peak_current,layer,pours,splits,notes
net,I2C_SCL,clock,I2C,400k,U1,12,PB6,U4;U5,,GND on In1,,,,,,,,,,,,pull-ups R7/R8 4.7k to 3V3
net,I2C_SDA,data,I2C,400k,U1,13,PB7,U4;U5,,GND on In1,,,,,,,,,,,,
net,SPI_SCK,clock,SPI,20 MHz,U1,21,PA5,U6,,GND on In1,keep under 60 mm,,,,,,,,,,,
net,UART_TX,data,UART,115200,U1,30,PA9,J3.2,,GND on In1,,,,,,,,,,,,to the debug header
net,USB_DP,diff pair,USB,12 MHz,U1,44,PA12,J1.3,USB_DN,GND on In1,90 Ω diff,,,,,,,,,,,
net,USB_DN,diff pair,USB,12 MHz,U1,43,PA11,J1.2,USB_DP,GND on In1,90 Ω diff,,,,,,,,,,,
net,MCO,clock,,8 MHz,U1,41,PA8,U7,,GND on In1,,,,,,,,,,,,
net,LED_STATUS,control,,,none,,,,,,,,,,,,,,,,,slow GPIO: no driver loop
net,AIN_SENSE,analog,,,,,,U1.9,,AGND,,,,,,,,,,,,keep away from SPI_SCK
net,VBUS,power,,,,,,,,,,,,,,,,,,,,
net,GND,ground,,,,,,,,,,,,,,,,,,,,
load,3V3,,,,,,,,,,,3.3,U2,5,U1,1,45mA,120mA,,,,MCU at full speed
load,3V3,,,,,,,,,,,3.3,U2,5,U4,8,2mA,5mA,,,,
load,3V3,,,,,,,,,,,3.3,U2,5,U5,4,15mA,30mA,,,,
load,3V3,,,,,,,,,,,3.3,U2,5,U6,8,8mA,25mA,,,,
load,VBUS,,,,,,,,,,,5,J1,1,U2,3,80mA,250mA,,,,
layer,,,,,,,,,,,,,,,,,,,Top,signals and GND pour,,
layer,,,,,,,,,,,,,,,,,,,In1,solid GND plane,,reference for every signal on Top
layer,,,,,,,,,,,,,,,,,,,In2,3V3 and VBUS pours,3V3 / VBUS split under U2,
layer,,,,,,,,,,,,,,,,,,,Bottom,GND pour,AGND joins GND at one point near U1,star ground for AIN_SENSE
`;
